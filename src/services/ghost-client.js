import jwt from "jsonwebtoken";
import config from "../config.js";
import crypto from "crypto";
import { sanitizeFilename } from "../utils/sanitize.js";

export class GhostClient {
  constructor() {
    if (!config.ghostAdminApiKey) {
      console.warn("Warning: GHOST_ADMIN_API_KEY not set");
      return;
    }

    const [id, secret] = config.ghostAdminApiKey.split(":");
    this.keyId = id;
    this.secret = Buffer.from(secret, "hex");
    this.baseUrl = config.ghostUrl;
  }

  generateToken() {
    if (!this.secret) {
      throw new Error("Ghost Admin API key not configured");
    }

    const iat = Math.floor(Date.now() / 1000);
    const exp = iat + 5 * 60; // 5 minutes

    return jwt.sign({}, this.secret, {
      keyid: this.keyId,
      algorithm: "HS256",
      expiresIn: "5m",
      audience: "/admin/",
    });
  }

  async request(method, endpoint, data = null) {
    const url = `${this.baseUrl}/ghost/api/admin${endpoint}`;
    const token = this.generateToken();

    const options = {
      method,
      headers: {
        Authorization: `Ghost ${token}`,
        "Content-Type": "application/json",
      },
    };

    if (data) {
      options.body = JSON.stringify(data);
    }

    const response = await fetch(url, options);
    const responseData = await response.json();

    if (!response.ok) {
      const errorMsg = responseData.errors?.[0]?.message || "Unknown error";
      throw new Error(`Ghost API error: ${errorMsg}`);
    }

    return responseData;
  }

  async createPost(postData) {
    const response = await this.request("POST", "/posts/", {
      posts: [postData],
    });
    return response.posts[0];
  }

  async uploadImage(buffer, filename) {
    const url = `${this.baseUrl}/ghost/api/admin/images/upload/`;
    const token = this.generateToken();

    // Sanitize filename to prevent header injection
    const safeFilename = sanitizeFilename(filename);

    const boundary = "----FormBoundary" + crypto.randomBytes(16).toString("hex");

    const contentType = this.getMimeType(safeFilename);
    const header = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, buffer, footer]);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Ghost ${token}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": body.length.toString(),
      },
      body,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Image upload failed: ${response.status} ${text}`);
    }

    const data = await response.json();
    return data.images[0].url;
  }

  getMimeType(filename) {
    const ext = filename.toLowerCase().split(".").pop();
    const types = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      svg: "image/svg+xml",
    };
    return types[ext] || "application/octet-stream";
  }

  async ensureTag(slug, name = null) {
    try {
      const response = await this.request("GET", `/tags/slug/${slug}/`);
      return response.tags[0];
    } catch (error) {
      if (error.message.includes("not found") || error.message.includes("404")) {
        const response = await this.request("POST", "/tags/", {
          tags: [{ slug, name: name || slug }],
        });
        return response.tags[0];
      }
      throw error;
    }
  }

  async ensureAuthor(sourceName) {
    const slug = sourceName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 50);

    try {
      // Try to find existing user by slug
      const response = await this.request("GET", `/users/slug/${slug}/`);
      return response.users[0].id;
    } catch (error) {
      // If not found, try to find any user with partial match or create placeholder
      if (error.message.includes("not found") || error.message.includes("404") || error.message.includes("Resource")) {
        console.log(`    Author "${sourceName}" not found, using default author`);
        // Fall back to the first available user (site owner)
        try {
          const usersResponse = await this.request("GET", "/users/?limit=1");
          if (usersResponse.users && usersResponse.users.length > 0) {
            return usersResponse.users[0].id;
          }
        } catch (e) {
          console.log(`    Could not get default author: ${e.message}`);
        }
      }
      throw error;
    }
  }
}

export default new GhostClient();
