#!/usr/bin/env node
import { Command } from "commander";
import db from "./db.js";
import feedFetcher from "./services/feed-fetcher.js";
import scheduler from "./services/scheduler.js";

const program = new Command();

program
  .name("rss-aggregator")
  .description("Ghost RSS Aggregator CLI")
  .version("1.0.0");

// Add a new feed source
program
  .command("add")
  .description("Add a new feed source")
  .requiredOption("-n, --name <name>", "Feed source name")
  .requiredOption("-u, --url <url>", "RSS feed URL")
  .option("-t, --tag <tag>", "Default tag slug", "news")
  .option("-s, --status <status>", "Post status (draft/published)", "draft")
  .option("-k, --keywords <keywords>", "Comma-separated keyword filter")
  .action((options) => {
    try {
      const stmt = db.prepare(`
        INSERT INTO feed_sources (name, feed_url, default_tag_slug, post_status, keyword_filter)
        VALUES (?, ?, ?, ?, ?)
      `);
      const result = stmt.run(
        options.name,
        options.url,
        options.tag,
        options.status,
        options.keywords || null
      );
      console.log(`Added feed source: ${options.name} (ID: ${result.lastInsertRowid})`);
    } catch (error) {
      console.error("Error adding feed:", error.message);
      process.exit(1);
    }
  });

// List all feed sources
program
  .command("list")
  .description("List all feed sources")
  .action(() => {
    const feeds = db.prepare("SELECT * FROM feed_sources ORDER BY name").all();
    if (feeds.length === 0) {
      console.log("No feed sources configured");
      return;
    }
    console.log("\nFeed Sources:");
    console.log("-".repeat(80));
    for (const feed of feeds) {
      const status = feed.is_active ? "active" : "inactive";
      console.log(`[${feed.id}] ${feed.name} (${status})`);
      console.log(`    URL: ${feed.feed_url}`);
      console.log(`    Tag: ${feed.default_tag_slug}, Status: ${feed.post_status}`);
      if (feed.keyword_filter) {
        console.log(`    Keywords: ${feed.keyword_filter}`);
      }
      if (feed.last_fetched_at) {
        console.log(`    Last fetched: ${feed.last_fetched_at}`);
      }
      console.log();
    }
  });

// Remove a feed source
program
  .command("remove <id>")
  .description("Remove a feed source by ID")
  .action((id) => {
    const feed = db.prepare("SELECT name FROM feed_sources WHERE id = ?").get(id);
    if (!feed) {
      console.error(`Feed source ID ${id} not found`);
      process.exit(1);
    }
    db.prepare("DELETE FROM feed_sources WHERE id = ?").run(id);
    console.log(`Removed feed source: ${feed.name}`);
  });

// Toggle feed active status
program
  .command("toggle <id>")
  .description("Toggle feed source active/inactive")
  .action((id) => {
    const feed = db.prepare("SELECT * FROM feed_sources WHERE id = ?").get(id);
    if (!feed) {
      console.error(`Feed source ID ${id} not found`);
      process.exit(1);
    }
    const newStatus = feed.is_active ? 0 : 1;
    db.prepare("UPDATE feed_sources SET is_active = ? WHERE id = ?").run(newStatus, id);
    console.log(`${feed.name} is now ${newStatus ? "active" : "inactive"}`);
  });

// Fetch feeds now
program
  .command("fetch")
  .description("Fetch all active feeds now")
  .option("-f, --feed <id>", "Fetch specific feed by ID")
  .action(async (options) => {
    try {
      if (options.feed) {
        const feed = db.prepare("SELECT * FROM feed_sources WHERE id = ?").get(options.feed);
        if (!feed) {
          console.error(`Feed source ID ${options.feed} not found`);
          process.exit(1);
        }
        const result = await feedFetcher.fetchFeed(feed);
        console.log(`\nResult: ${result.itemsImported} imported, ${result.itemsSkipped} skipped`);
      } else {
        await feedFetcher.fetchAllFeeds();
      }
    } catch (error) {
      console.error("Fetch error:", error.message);
      process.exit(1);
    }
  });

// Show fetch logs
program
  .command("logs")
  .description("Show recent fetch logs")
  .option("-n, --limit <number>", "Number of logs to show", "20")
  .action((options) => {
    const logs = db.prepare(`
      SELECT fl.*, fs.name as feed_name
      FROM fetch_logs fl
      JOIN feed_sources fs ON fl.feed_source_id = fs.id
      ORDER BY fl.started_at DESC
      LIMIT ?
    `).all(parseInt(options.limit));

    if (logs.length === 0) {
      console.log("No fetch logs found");
      return;
    }

    console.log("\nRecent Fetch Logs:");
    console.log("-".repeat(80));
    for (const log of logs) {
      const status = log.status === "success" ? "+" : log.status === "error" ? "x" : "...";
      console.log(`${status} [${log.started_at}] ${log.feed_name}`);
      console.log(`  Found: ${log.items_found || 0}, Imported: ${log.items_imported || 0}, Skipped: ${log.items_skipped || 0}`);
      if (log.error_message) {
        console.log(`  Error: ${log.error_message}`);
      }
    }
  });

// Show stats
program
  .command("stats")
  .description("Show aggregator statistics")
  .action(() => {
    const feedCount = db.prepare("SELECT COUNT(*) as count FROM feed_sources").get().count;
    const activeCount = db.prepare("SELECT COUNT(*) as count FROM feed_sources WHERE is_active = 1").get().count;
    const importedCount = db.prepare("SELECT COUNT(*) as count FROM imported_items").get().count;
    const last24h = db.prepare(
      "SELECT COUNT(*) as count FROM imported_items WHERE imported_at > datetime('now', '-1 day')"
    ).get().count;

    console.log("\nRSS Aggregator Statistics:");
    console.log("-".repeat(40));
    console.log(`Feed sources: ${feedCount} (${activeCount} active)`);
    console.log(`Total imported items: ${importedCount}`);
    console.log(`Imported in last 24h: ${last24h}`);
  });

// Start daemon mode
program
  .command("daemon")
  .description("Run in daemon mode with scheduled fetching")
  .action(() => {
    console.log("Starting RSS Aggregator daemon...");
    scheduler.start();

    // Keep process running
    process.on("SIGINT", () => {
      console.log("\nShutting down...");
      scheduler.stop();
      process.exit(0);
    });
  });

program.parse();
