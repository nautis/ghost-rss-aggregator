// Validate required environment variables
if (!process.env.GHOST_ADMIN_API_KEY) {
  console.error("ERROR: GHOST_ADMIN_API_KEY environment variable is required");
  console.error("Set it with: export GHOST_ADMIN_API_KEY='your-key-id:your-secret'");
  process.exit(1);
}

if (!process.env.GHOST_URL) {
  console.error("ERROR: GHOST_URL environment variable is required");
  console.error("Set it with: export GHOST_URL='https://your-ghost-site.com'");
  process.exit(1);
}

export default {
  ghostUrl: process.env.GHOST_URL,
  ghostAdminApiKey: process.env.GHOST_ADMIN_API_KEY,
  dbPath: process.env.DB_PATH || "./data/aggregator.db",
  
  // Cron schedule (default: every 30 minutes)
  fetchInterval: process.env.FETCH_INTERVAL || "*/30 * * * *",
  
  // Default settings for new posts
  defaultPostStatus: "draft",
  defaultTagSlug: "news",
  
  // Image handling
  maxImageSize: 5 * 1024 * 1024, // 5MB
  imageTimeout: 30000, // 30 seconds
};
