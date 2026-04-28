import Parser from "rss-parser";
import { parseFeed as htmlParseFeed } from "htmlparser2";
import { decodeHTML } from "entities";
import { execFile } from "child_process";
import { promisify } from "util";
import crypto from "crypto";
import db from "../db.js";
import ghostClient from "./ghost-client.js";
import config from "../config.js";
import { assertResolvedUrlSafe } from "../utils/url-validator.js";
import { escapeHtml } from "../utils/sanitize.js";

const execFileAsync = promisify(execFile);

const MAX_REDIRECTS = 3;
const MAX_FEED_BYTES = 10 * 1024 * 1024;       // 10MB cap on a single feed body
const MAX_FEED_ITEMS_PARSED = 200;             // sanity ceiling before slice(0,10)

const parser = new Parser({
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

/**
 * Sniff the first bytes of a buffer to confirm it's actually an image. We don't
 * trust server Content-Type headers — a malicious feed can serve HTML/JS under
 * `image/jpeg` and Ghost would happily store and re-serve it under our domain.
 * Returns the detected type or null.
 */
function sniffImageType(buf) {
  if (buf.length < 12) return null;

  // SVG / XML — text-based, easy to disguise as anything. Reject by name below;
  // here we just detect so the caller can refuse.
  const head = buf.slice(0, 256).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "svg";

  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "jpeg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return "png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return "gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "webp";

  return null;
}

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
      const feed = await this.fetchAndParseFeed(feedSource.feed_url);
      const items = feed.items.slice(0, 10);
      itemsFound = items.length;
      console.log(`  Found ${feed.items.length} items, processing ${itemsFound}`);

      const authorId = await this.ensureAuthor(feedSource.name);

      const existingUrls = new Set(
        db.prepare("SELECT item_url FROM imported_items")
          .all()
          .map(row => this.normalizeUrl(row.item_url))
      );

      // Local DB is the source of truth for dedup (unique index on item_url).
      // We no longer pull every Ghost post tagged 'news' — that grew O(n) per cycle.

      for (const item of items) {
        try {
          const itemUrl = item.link || item.guid;
          const normalizedUrl = itemUrl ? this.normalizeUrl(itemUrl) : null;

          if (!itemUrl || existingUrls.has(normalizedUrl)) {
            itemsSkipped++;
            continue;
          }

          // canonical_url is rendered by Ghost — refuse anything that isn't http(s)
          if (item.link && !isSafeCanonicalLink(item.link)) {
            console.log(`  Skipping item with unsafe link: ${item.title?.substring(0, 50)}`);
            itemsSkipped++;
            continue;
          }

          if (feedSource.keyword_filter) {
            const keywords = feedSource.keyword_filter.split(",").map(k => k.trim().toLowerCase());
            const content = `${item.title || ""} ${item.contentSnippet || ""}`.toLowerCase();
            if (!keywords.some(kw => content.includes(kw))) {
              itemsSkipped++;
              continue;
            }
          }

          const ghostPost = await this.importItem(item, feedSource, authorId);
          if (ghostPost) {
            try {
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
            } catch (insertErr) {
              // UNIQUE violation = race with concurrent fetch; not fatal
              if (!insertErr.message?.includes("UNIQUE")) throw insertErr;
            }

            existingUrls.add(normalizedUrl);
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
    if (this.authorCache.has(sourceName)) return this.authorCache.get(sourceName);
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
        // Fallback: only re-use the original URL if we already validated its scheme
        // and it's HTTPS. This means hot-linking, which we accept as a documented
        // tradeoff vs. losing the image.
        if (imageUrl.startsWith("https://")) {
          featureImageUrl = imageUrl;
          console.log(`    Using original image URL as fallback`);
        }
      }
    }

    const content = item.content || item.contentSnippet || item.summary || "";
    const excerpt = this.createExcerpt(content, 300);
    const safeExcerpt = escapeHtml(excerpt);
    const html = `<p>${safeExcerpt}</p>`;

    const postData = {
      title: item.title,
      html,
      status: feedSource.post_status || config.defaultPostStatus,
      feature_image: featureImageUrl,
      custom_excerpt: excerpt,
      canonical_url: item.link,
      published_at: item.isoDate || new Date().toISOString(),
      authors: [{ id: authorId }],
      tags: [
        { slug: "news" },
        { slug: feedSource.default_tag_slug || config.defaultTagSlug },
        { slug: this.slugify(feedSource.name) },
      ],
    };

    return await ghostClient.createPost(postData);
  }

  extractImageUrl(item) {
    if (item.mediaThumbnail?.$?.url) return item.mediaThumbnail.$.url;

    if (item.mediaContent?.length > 0) {
      const media = item.mediaContent.find(m =>
        m.$ && (m.$.medium === "image" || (m.$.type && m.$.type.startsWith("image/")))
      );
      if (media?.$?.url) return media.$.url;
    }

    if (item.enclosure?.url) {
      const type = item.enclosure.type || "";
      if (type.startsWith("image/") || /\.(jpg|jpeg|png|gif|webp)$/i.test(item.enclosure.url)) {
        return item.enclosure.url;
      }
    }

    const contentHtml = item.contentEncoded || item["content:encoded"] || item.content || "";
    const imgMatch = contentHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch?.[1]) return imgMatch[1];

    const youtubeMatch = contentHtml.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]{11})|youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})|youtu\.be\/([a-zA-Z0-9_-]{11})/i);
    if (youtubeMatch) {
      const videoId = youtubeMatch[1] || youtubeMatch[2] || youtubeMatch[3];
      console.log(`    Found YouTube video: ${videoId}`);
      return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
    }

    return null;
  }

  /**
   * Fetch an image with manual redirect handling and per-hop SSRF revalidation,
   * streaming the body so we can abort early if the server lies about size or
   * serves something that isn't an image.
   */
  async uploadImageToGhost(imageUrl) {
    let currentUrl = imageUrl;
    let response;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertResolvedUrlSafe(currentUrl);

      response = await fetch(currentUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "image/*,*/*;q=0.8",
          "Referer": new URL(currentUrl).origin,
        },
        redirect: "manual",
        signal: AbortSignal.timeout(config.imageTimeout),
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error(`Redirect with no Location header (${response.status})`);
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      break;
    }

    if (response.status >= 300 && response.status < 400) {
      throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);
    }
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.status}`);
    }

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    if (contentType.startsWith("image/svg")) {
      throw new Error("SVG images rejected (XSS vector)");
    }
    if (!contentType.startsWith("image/")) {
      throw new Error(`Not an image: ${contentType}`);
    }

    // Stream the body with a running size cap. Don't trust Content-Length —
    // an attacker can lie about it or omit it.
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > config.maxImageSize) {
          await reader.cancel();
          throw new Error(`Image too large (>${config.maxImageSize} bytes)`);
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }

    const buffer = Buffer.concat(chunks);

    if (buffer.length < 1000) {
      throw new Error("Image too small, likely an error page");
    }

    const sniffed = sniffImageType(buffer);
    if (!sniffed) {
      throw new Error("Buffer does not match a known image format");
    }
    if (sniffed === "svg") {
      throw new Error("SVG images rejected (XSS vector)");
    }

    const urlPath = new URL(currentUrl).pathname;
    let filename = urlPath.split("/").pop() || "image.jpg";
    filename = filename.replace(/\?.*$/, "");

    if (!/\.(jpg|jpeg|png|gif|webp)$/i.test(filename)) {
      const ext = sniffed === "jpeg" ? "jpg" : sniffed;
      filename = `image-${Date.now()}.${ext}`;
    }

    return await ghostClient.uploadImage(buffer, filename);
  }

  createExcerpt(content, maxLength = 300) {
    let text = content.replace(/<[^>]+>/g, " ");
    text = decodeHTML(text);                    // entities lib — preserves em/en/curly chars
    text = text.replace(/\s+/g, " ").trim();

    if (text.length <= maxLength) return text;

    const truncateAt = maxLength - 3;
    text = text.substring(0, truncateAt);
    const lastSpace = text.lastIndexOf(" ");
    if (lastSpace > truncateAt * 0.8) text = text.substring(0, lastSpace);

    return text + "...";
  }

  hashContent(item) {
    const content = `${item.title || ""}|${item.link || ""}`;
    return crypto.createHash("sha256").update(content).digest("hex").substring(0, 32);
  }

  /**
   * Fetch + parse an RSS feed using curl (Node's fetch gets TLS-fingerprinted
   * and blocked by Cloudflare/WAFs on some sites; curl passes through).
   *
   * We can't use curl `-L` because it follows redirects to anywhere. Instead
   * we run with `--max-redirs 0` and follow manually, revalidating each hop
   * and pinning the resolved IP via `--resolve` to close the TOCTOU window.
   */
  async fetchAndParseFeed(url) {
    const body = await this._curlGetWithRevalidatedRedirects(url);

    try {
      const feed = await parser.parseString(body);
      if (feed.items?.length > MAX_FEED_ITEMS_PARSED) {
        feed.items = feed.items.slice(0, MAX_FEED_ITEMS_PARSED);
      }
      return feed;
    } catch {
      console.log("  rss-parser failed, falling back to htmlparser2");
      const feed = htmlParseFeed(body);
      if (!feed) throw new Error("Feed could not be parsed by either rss-parser or htmlparser2");
      const items = (feed.items || []).slice(0, MAX_FEED_ITEMS_PARSED).map(item => ({
        title: item.title,
        link: item.link,
        guid: item.id || item.link,
        pubDate: item.pubDate?.toISOString?.() || item.pubDate,
        isoDate: item.pubDate?.toISOString?.() || item.pubDate,
        content: item.description || "",
        contentSnippet: item.description?.replace(/<[^>]*>/g, "").substring(0, 300) || "",
      }));
      return { items };
    }
  }

  async _curlGetWithRevalidatedRedirects(url, hop = 0) {
    if (hop > MAX_REDIRECTS) throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);

    const addresses = await assertResolvedUrlSafe(url);
    const parsed = new URL(url);
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    // Pin to the first resolved address — closes the TOCTOU rebinding window.
    // Prefer IPv4 if available (more reliable across hosts); fall back to IPv6.
    const pinned = addresses.find(a => a.family === 4)?.address || addresses[0].address;

    const args = [
      "-sS",
      "-i",                                                     // include response headers
      "--max-redirs", "0",
      "--max-time", "30",
      "--max-filesize", String(MAX_FEED_BYTES),
      "--resolve", `${parsed.hostname}:${port}:${pinned}`,
      "-H", "User-Agent: Ghost-RSS-Aggregator/1.1",
      url,
    ];

    let stdout;
    try {
      const result = await execFileAsync("curl", args, { maxBuffer: MAX_FEED_BYTES });
      stdout = result.stdout;
    } catch (e) {
      // curl exits non-zero on 3xx-without-Location; we handle 3xx via -i header parse below
      stdout = e.stdout || "";
      if (!stdout) throw new Error(`curl failed: ${e.message}`);
    }

    // Parse status + headers + body. -i emits one header block per response;
    // since we disabled redirects, there's exactly one block.
    const splitIdx = stdout.indexOf("\r\n\r\n");
    if (splitIdx === -1) throw new Error("Malformed response (no header/body split)");
    const headerBlock = stdout.substring(0, splitIdx);
    const body = stdout.substring(splitIdx + 4);

    const statusMatch = headerBlock.match(/^HTTP\/[\d.]+\s+(\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

    if (status >= 300 && status < 400) {
      const locMatch = headerBlock.match(/^location:\s*(.+)$/im);
      if (!locMatch) throw new Error(`Redirect with no Location header (${status})`);
      const next = new URL(locMatch[1].trim(), url).toString();
      return this._curlGetWithRevalidatedRedirects(next, hop + 1);
    }

    if (status < 200 || status >= 300) {
      throw new Error(`HTTP ${status} fetching feed`);
    }

    return body;
  }

  normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      u.searchParams.delete("utm_source");
      u.searchParams.delete("utm_medium");
      u.searchParams.delete("utm_campaign");
      u.searchParams.delete("utm_content");
      u.searchParams.delete("utm_term");
      let normalized = u.toString();
      if (normalized.endsWith("/") && u.pathname !== "/") normalized = normalized.slice(0, -1);
      return normalized;
    } catch {
      return url;
    }
  }

  slugify(text) {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").substring(0, 50);
  }
}

/** http(s)-only check for canonical_url passed straight to Ghost. */
function isSafeCanonicalLink(url) {
  try {
    return ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

export default new FeedFetcher();
