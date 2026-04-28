import cron from "node-cron";
import feedFetcher from "./feed-fetcher.js";
import config from "../config.js";

export class Scheduler {
  constructor() {
    this.task = null;
    this.running = false;
  }

  start() {
    if (this.task) {
      console.log("Scheduler already running");
      return;
    }

    console.log(`Starting scheduler with interval: ${config.fetchInterval}`);

    this.task = cron.schedule(config.fetchInterval, async () => {
      if (this.running) {
        console.log(`[${new Date().toISOString()}] Skipping tick — previous fetch still running`);
        return;
      }
      this.running = true;
      console.log(`\n[${new Date().toISOString()}] Running scheduled fetch...`);
      try {
        await feedFetcher.fetchAllFeeds();
      } catch (error) {
        console.error("Scheduled fetch error:", error.message);
      } finally {
        this.running = false;
      }
    });

    console.log("Scheduler started");
  }

  stop() {
    if (this.task) {
      this.task.stop();
      this.task = null;
      console.log("Scheduler stopped");
    }
  }

  async runOnce() {
    console.log("Running one-time fetch...");
    await feedFetcher.fetchAllFeeds();
  }
}

export default new Scheduler();
