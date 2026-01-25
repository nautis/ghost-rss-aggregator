import jwt from "jsonwebtoken";
import path from "path";
import { validateUrl } from "./src/utils/url-validator.js";

// Require environment variables - no hardcoded credentials
const GHOST_URL = process.env.GHOST_URL;
const GHOST_API_KEY = process.env.GHOST_ADMIN_API_KEY;

if (!GHOST_URL || !GHOST_API_KEY) {
  console.error("ERROR: Required environment variables not set");
  console.error("  GHOST_URL - Your Ghost site URL");
  console.error("  GHOST_ADMIN_API_KEY - Your Ghost Admin API key");
  process.exit(1);
}

const [keyId, secret] = GHOST_API_KEY.split(":");

function generateToken() {
  return jwt.sign({}, Buffer.from(secret, "hex"), {
    keyid: keyId,
    algorithm: "HS256",
    expiresIn: "5m",
    audience: "/admin/",
  });
}

async function uploadImageToGhost(imageBuffer, filename, contentType) {
  const token = generateToken();
  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: contentType }), filename);
  formData.append("purpose", "image");

  const response = await fetch(`${GHOST_URL}/ghost/api/admin/images/upload/`, {
    method: "POST",
    headers: {
      Authorization: `Ghost ${token}`,
    },
    body: formData,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Upload failed: ${error}`);
  }

  const data = await response.json();
  return data.images[0].url;
}

async function getPostsWithWpImages() {
  const token = generateToken();
  const response = await fetch(
    `${GHOST_URL}/ghost/api/admin/posts/?limit=all&formats=html`,
    {
      headers: { Authorization: `Ghost ${token}` },
    }
  );
  const data = await response.json();
  return data.posts.filter((p) => p.html && p.html.includes("wp-content/uploads"));
}

async function updatePost(postId, html, updatedAt) {
  const token = generateToken();
  const response = await fetch(`${GHOST_URL}/ghost/api/admin/posts/${postId}/`, {
    method: "PUT",
    headers: {
      Authorization: `Ghost ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      posts: [{ html, updated_at: updatedAt }],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Update failed: ${error}`);
  }

  return await response.json();
}

async function downloadImage(url) {
  try {
    // SSRF protection: validate URL before fetching
    const urlCheck = validateUrl(url);
    if (!urlCheck.valid) {
      console.log(`    URL blocked: ${urlCheck.reason}`);
      return null;
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GhostMigration/1.0)",
      },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      return null;
    }

    // Validate final URL after redirects
    if (response.url !== url) {
      const redirectCheck = validateUrl(response.url);
      if (!redirectCheck.valid) {
        console.log(`    Redirect blocked: ${redirectCheck.reason}`);
        return null;
      }
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    const buffer = Buffer.from(await response.arrayBuffer());
    return { buffer, contentType };
  } catch (err) {
    return null;
  }
}

async function tryDownloadWithAlternativeFormats(wpUrl) {
  // Try the original URL first (if not AVIF)
  if (!wpUrl.endsWith('.avif')) {
    const result = await downloadImage(wpUrl);
    if (result) return { result, url: wpUrl };
  }

  // For AVIF files, try alternative formats
  const baseUrl = wpUrl.replace(/\.avif$/, '');
  const alternatives = ['.jpg', '.jpeg', '.png', '.webp'];

  for (const ext of alternatives) {
    const altUrl = baseUrl + ext;
    const result = await downloadImage(altUrl);
    if (result) {
      console.log(`    Found alternative: ${ext}`);
      return { result, url: altUrl };
    }
  }

  // Try without the extension modification for non-avif URLs
  if (wpUrl.endsWith('.avif')) {
    const result = await downloadImage(wpUrl);
    if (result) return { result, url: wpUrl };
  }

  return null;
}

async function migrateImages() {
  console.log("Fetching posts with WordPress images...");
  const posts = await getPostsWithWpImages();
  console.log(`Found ${posts.length} posts with WordPress images\n`);

  const urlMapping = new Map(); // wpUrl -> ghostUrl
  let migratedCount = 0;
  let failedCount = 0;

  for (const post of posts) {
    console.log(`\nProcessing: ${post.title.substring(0, 50)}...`);

    // Find all WordPress image URLs in this post
    const wpUrls = post.html.match(/https?:\/\/tellingtime\.com\/wp-content\/uploads\/[^"]+/g) || [];
    const uniqueUrls = [...new Set(wpUrls)];

    let updatedHtml = post.html;
    let hasChanges = false;

    for (const wpUrl of uniqueUrls) {
      // Check if we already migrated this URL
      if (urlMapping.has(wpUrl)) {
        updatedHtml = updatedHtml.split(wpUrl).join(urlMapping.get(wpUrl));
        hasChanges = true;
        continue;
      }

      const filename = path.basename(wpUrl).replace(/\?.*$/, '').replace(/\.avif$/, '.jpg');
      console.log(`  Migrating: ${path.basename(wpUrl)}`);

      try {
        const download = await tryDownloadWithAlternativeFormats(wpUrl);
        if (!download) {
          console.log(`    Not found (tried multiple formats)`);
          failedCount++;
          continue;
        }

        const { result, url: actualUrl } = download;
        const actualFilename = path.basename(actualUrl).replace(/\?.*$/, '');
        const ghostUrl = await uploadImageToGhost(result.buffer, actualFilename, result.contentType);

        console.log(`    -> ${ghostUrl}`);
        urlMapping.set(wpUrl, ghostUrl);
        updatedHtml = updatedHtml.split(wpUrl).join(ghostUrl);
        hasChanges = true;
        migratedCount++;
      } catch (err) {
        console.error(`    Error: ${err.message}`);
        failedCount++;
      }
    }

    if (hasChanges) {
      try {
        await updatePost(post.id, updatedHtml, post.updated_at);
        console.log(`  Post updated!`);
      } catch (err) {
        console.error(`  Failed to update post: ${err.message}`);
      }
    }
  }

  console.log(`\n=== Migration Complete ===`);
  console.log(`Migrated: ${migratedCount} images`);
  console.log(`Failed: ${failedCount} images`);
  console.log(`URL mappings: ${urlMapping.size}`);
}

migrateImages().catch(console.error);
