export default {
  ghostUrl: process.env.GHOST_URL || "https://tellingtime.com",
  ghostAdminApiKey: process.env.GHOST_ADMIN_API_KEY || "bb4d6377764d99b2a406149e:da704954f40a155e9ea765d079782db193943a3bbcdf9f6f76f2077665d0176a",
  dbPath: process.env.DB_PATH || "/opt/rss-aggregator/data/aggregator.db",
  
  // Cron schedule (default: every 30 minutes)
  fetchInterval: process.env.FETCH_INTERVAL || "*/30 * * * *",
  
  // Default settings for new posts
  defaultPostStatus: "draft",
  defaultTagSlug: "news",
  
  // Image handling
  maxImageSize: 5 * 1024 * 1024, // 5MB
  imageTimeout: 30000, // 30 seconds
};
