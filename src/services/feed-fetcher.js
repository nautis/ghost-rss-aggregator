import Parser from "rss-parser";
import crypto from "crypto";
import db from "../db.js";
import ghostClient from "./ghost-client.js";
import config from "../config.js";
import { assertUrlSafe, validateUrl } from "../utils/url-validator.js";
import { escapeHtml, stripHtml } from "../utils/sanitize.js";

const parser = new Parser({
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "application/rss+xml, application/xml, text/xml, application/atom+xml, */*;q=0.8",
  },
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail"],
      ["enclosure", "enclosure"],
      ["dc:creator", "creator"],
      ["content:encoded", "contentEncoded"],
    ],
  },
});

export class FeedFetcher {
  constructor() {
    this.authorCache = new Map();
  }

  async fetchAllFeeds() {
    const feeds = db.prepare("SELECT * FROM feed_sources WHERE is_active = 1").all();
    console.log(`Found ${feeds.length} active feeds`);

    for (const feed of feeds) {
      try {
        await this.fetchFeed(feed);
      } catch (error) {
        console.error(`Error fetching feed ${feed.name}:`, error.message);
      }
    }
  }

  async fetchFeed(feedSource) {
    console.log(`\nFetching: ${feedSource.name} (${feedSource.feed_url})`);

    const logStmt = db.prepare(
      "INSERT INTO fetch_logs (feed_source_id, started_at, status) VALUES (?, datetime('now'), 'running')"
    );
    const logResult = logStmt.run(feedSource.id);
    const logId = logResult.lastInsertRowid;

    let itemsFound = 0;
    let itemsImported = 0;
    let itemsSkipped = 0;

    try {
      // SSRF protection: validate feed URL before fetching
      assertUrlSafe(feedSource.feed_url);

      const feed = await parser.parseURL(feedSource.feed_url);
      // Limit to most recent 10 items per feed to avoid timeouts
      const items = feed.items.slice(0, 10);
      itemsFound = items.length;
      console.log(`  Found ${feed.items.length} items, processing ${itemsFound}`);

      // Ensure we have an author for this feed source
      const authorId = await this.ensureAuthor(feedSource.name);

      // Check local DB for already-imported URLs
      const existingUrls = new Set(
        db.prepare("SELECT item_url FROM imported_items WHERE feed_source_id = ?")
          .all(feedSource.id)
          .map(row => row.item_url)
      );

      // Also check Ghost for existing posts with same canonical_url (prevents dupes if local DB cleared)
      try {
        const ghostPosts = await ghostClient.request("GET", "/posts/?filter=tag:news&limit=all&fields=canonical_url");
        ghostPosts.posts.forEach(p => {
          if (p.canonical_url) existingUrls.add(p.canonical_url);
        });
      } catch (e) {
        console.log("  Warning: Could not fetch existing Ghost posts for dedup check");
      }

      for (const item of items) {
        try {
          const itemUrl = item.link || item.guid;
          if (!itemUrl || existingUrls.has(itemUrl)) {
            itemsSkipped++;
            continue;
          }

          if (feedSource.keyword_filter) {
            const keywords = feedSource.keyword_filter.split(",").map(k => k.trim().toLowerCase());
            const content = `${item.title || ""} ${item.contentSnippet || ""}`.toLowerCase();
            const hasKeyword = keywords.some(kw => content.includes(kw));
            if (!hasKeyword) {
              itemsSkipped++;
              continue;
            }
          }

          const ghostPost = await this.importItem(item, feedSource, authorId);
          if (ghostPost) {
            db.prepare(`
              INSERT INTO imported_items
              (feed_source_id, item_guid, item_url, content_hash, ghost_post_id, original_title, original_pub_date)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(
              feedSource.id,
              item.guid || null,
              itemUrl,
              this.hashContent(item),
              ghostPost.id,
              item.title,
              item.pubDate || item.isoDate || null
            );

            existingUrls.add(itemUrl);
            itemsImported++;
            console.log(`  Imported: ${item.title?.substring(0, 50)}...`);
          }
        } catch (itemError) {
          console.error(`  Error importing item: ${itemError.message}`);
          itemsSkipped++;
        }
      }

      db.prepare(
        "UPDATE feed_sources SET last_fetched_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
      ).run(feedSource.id);

      db.prepare(
        "UPDATE fetch_logs SET completed_at = datetime('now'), status = 'success', items_found = ?, items_imported = ?, items_skipped = ? WHERE id = ?"
      ).run(itemsFound, itemsImported, itemsSkipped, logId);

      console.log(`  Summary: ${itemsImported} imported, ${itemsSkipped} skipped`);

    } catch (error) {
      db.prepare(
        "UPDATE fetch_logs SET completed_at = datetime('now'), status = 'error', error_message = ?, items_found = ?, items_imported = ?, items_skipped = ? WHERE id = ?"
      ).run(error.message, itemsFound, itemsImported, itemsSkipped, logId);

      throw error;
    }

    return { itemsFound, itemsImported, itemsSkipped };
  }

  async ensureAuthor(sourceName) {
    // Check cache first
    if (this.authorCache.has(sourceName)) {
      return this.authorCache.get(sourceName);
    }

    const authorId = await ghostClient.ensureAuthor(sourceName);
    this.authorCache.set(sourceName, authorId);
    return authorId;
  }

  async importItem(item, feedSource, authorId) {
    let imageUrl = this.extractImageUrl(item);
    let featureImageUrl = null;

    if (imageUrl) {
      try {
        console.log(`    Uploading image: ${imageUrl.substring(0, 60)}...`);
        featureImageUrl = await this.uploadImageToGhost(imageUrl);
        console.log(`    Image uploaded: ${featureImageUrl}`);
      } catch (imgError) {
        console.log(`    Image failed: ${imgError.message}`);
        // Try to use the original URL directly as a fallback
        if (imageUrl.startsWith("https://")) {
          featureImageUrl = imageUrl;
          console.log(`    Using original image URL as fallback`);
        }
      }
    }

    const content = item.content || item.contentSnippet || item.summary || "";
    const excerpt = this.createExcerpt(content, 300);

    // Minimal HTML - escape excerpt to prevent XSS
    const safeExcerpt = escapeHtml(excerpt);
    const html = `<p>${safeExcerpt}</p>`;

    const postData = {
      title: item.title,
      html: html,
      status: feedSource.post_status || config.defaultPostStatus,
      feature_image: featureImageUrl,
      custom_excerpt: excerpt,
      canonical_url: item.link,
      published_at: item.isoDate || new Date().toISOString(),  // Use ISO format (Ghost rejects RFC 2822)
      authors: [{ id: authorId }],  // Set author to the news source (Ghost needs object format)
      tags: [
        { slug: feedSource.default_tag_slug || config.defaultTagSlug },
        { slug: this.slugify(feedSource.name) }
      ],
    };

    return await ghostClient.createPost(postData);
  }

  extractImageUrl(item) {
    // Try media:thumbnail first
    if (item.mediaThumbnail && item.mediaThumbnail.$ && item.mediaThumbnail.$.url) {
      return item.mediaThumbnail.$.url;
    }

    // Try media:content
    if (item.mediaContent && item.mediaContent.length > 0) {
      const media = item.mediaContent.find(m =>
        m.$ && (m.$.medium === "image" || (m.$.type && m.$.type.startsWith("image/")))
      );
      if (media && media.$ && media.$.url) {
        return media.$.url;
      }
    }

    // Try enclosure
    if (item.enclosure && item.enclosure.url) {
      const type = item.enclosure.type || "";
      if (type.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(item.enclosure.url)) {
        return item.enclosure.url;
      }
    }

    // Try to extract from content HTML - prioritize contentEncoded (full content) over content (summary)
    const contentHtml = item.contentEncoded || item["content:encoded"] || item.content || "";
    const imgMatch = contentHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch && imgMatch[1]) {
      return imgMatch[1];
    }

    // Try to extract YouTube thumbnail from embedded videos
    const youtubeMatch = contentHtml.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})|youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})|youtu\.be\/([a-zA-Z0-9_-]{11})/i);
    if (youtubeMatch) {
      const videoId = youtubeMatch[1] || youtubeMatch[2] || youtubeMatch[3];
      console.log(`    Found YouTube video: ${videoId}`);
      return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    }

    return null;
  }

  async uploadImageToGhost(imageUrl) {
    // SSRF protection: validate image URL before fetching
    assertUrlSafe(imageUrl);

    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "image/*,*/*;q=0.8",
        "Referer": new URL(imageUrl).origin,
      },
      redirect: "follow",
      signal: AbortSignal.timeout(config.imageTimeout),
    });

    // SSRF protection: validate final URL after redirects
    if (response.url !== imageUrl) {
      const redirectCheck = validateUrl(response.url);
      if (!redirectCheck.valid) {
        throw new Error(`Redirect blocked: ${redirectCheck.reason}`);
      }
    }

    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      throw new Error(`Not an image: ${contentType}`);
    }

    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength) > config.maxImageSize) {
      throw new Error("Image too large");
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > config.maxImageSize) {
      throw new Error("Image too large");
    }

    if (buffer.length < 1000) {
      throw new Error("Image too small, likely an error page");
    }

    const urlPath = new URL(imageUrl).pathname;
    let filename = urlPath.split("/").pop() || "image.jpg";
    filename = filename.replace(/\?.*$/, "");

    // Ensure filename has an extension
    if (!/\.(jpg|jpeg|png|gif|webp|svg)$/i.test(filename)) {
      const ext = contentType.split("/")[1] || "jpg";
      filename = `image-${Date.now()}.${ext.replace("jpeg", "jpg")}`;
    }

    return await ghostClient.uploadImage(buffer, filename);
  }

  decodeHtmlEntities(text) {
    // Decode numeric entities (&#8230; &#38; etc)
    text = text.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(dec));
    // Decode hex entities (&#x2026; etc)
    text = text.replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
    // Decode named entities
    const entities = {
      '&nbsp;': ' ',
      '&amp;': '&',
      '&lt;': '<',
      '&gt;': '>',
      '&quot;': '"',
      '&apos;': "'",
      '&ndash;': '-',
      '&mdash;': '-',
      '&lsquo;': "'",
      '&rsquo;': "'",
      '&ldquo;': '"',
      '&rdquo;': '"',
      '&hellip;': '...',
      '&copy;': '(c)',
      '&reg;': '(R)',
      '&trade;': '(TM)',
    };
    for (const [entity, char] of Object.entries(entities)) {
      text = text.split(entity).join(char);
    }
    return text;
  }

  createExcerpt(content, maxLength = 300) {
    let text = content.replace(/<[^>]+>/g, " ");
    text = this.decodeHtmlEntities(text);
    text = text.replace(/\s+/g, " ").trim();

    if (text.length <= maxLength) {
      return text;
    }

    // Leave room for "..." suffix (Ghost limit is 300 chars)
    const truncateAt = maxLength - 3;
    text = text.substring(0, truncateAt);
    const lastSpace = text.lastIndexOf(" ");
    if (lastSpace > truncateAt * 0.8) {
      text = text.substring(0, lastSpace);
    }

    return text + "...";
  }

  hashContent(item) {
    const content = `${item.title || ""}|${item.link || ""}`;
    return crypto.createHash("sha256").update(content).digest("hex").substring(0, 32);
  }

  slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 50);
  }
}

export default new FeedFetcher();
