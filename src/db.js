import Database from "better-sqlite3";
import config from "./config.js";
import fs from "fs";
import path from "path";

// Ensure data directory exists
const dataDir = path.dirname(config.dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(config.dbPath);

// Enable foreign keys
db.pragma("foreign_keys = ON");

// Initialize schema
db.exec(`
  -- Feed source configuration
  CREATE TABLE IF NOT EXISTS feed_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    feed_url TEXT NOT NULL UNIQUE,
    site_url TEXT,
    
    -- Import settings
    is_active INTEGER DEFAULT 1,
    fetch_interval_minutes INTEGER DEFAULT 60,
    last_fetched_at TEXT,
    
    -- Content mapping
    default_tag_slug TEXT DEFAULT "news",
    post_status TEXT DEFAULT "draft",
    
    -- Filtering
    keyword_filter TEXT,
    
    -- Metadata
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  -- Track imported items to prevent duplicates
  CREATE TABLE IF NOT EXISTS imported_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source_id INTEGER NOT NULL,
    
    -- Deduplication keys
    item_guid TEXT,
    item_url TEXT NOT NULL,
    content_hash TEXT,
    
    -- Ghost reference
    ghost_post_id TEXT,
    
    -- Original data
    original_title TEXT,
    original_pub_date TEXT,
    
    imported_at TEXT DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (feed_source_id) REFERENCES feed_sources(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_imported_items_url ON imported_items(item_url);
  CREATE INDEX IF NOT EXISTS idx_imported_items_source ON imported_items(feed_source_id);

  -- Fetch history for monitoring
  CREATE TABLE IF NOT EXISTS fetch_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source_id INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    
    status TEXT,
    items_found INTEGER DEFAULT 0,
    items_imported INTEGER DEFAULT 0,
    items_skipped INTEGER DEFAULT 0,
    error_message TEXT,
    
    FOREIGN KEY (feed_source_id) REFERENCES feed_sources(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_fetch_logs_source ON fetch_logs(feed_source_id, started_at DESC);
`);

export default db;
