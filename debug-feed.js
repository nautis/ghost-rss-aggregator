import Parser from "rss-parser";

const parser = new Parser({
  customFields: {
    item: [
      ["media:content", "mediaContent", { keepArray: true }],
      ["media:thumbnail", "mediaThumbnail"],
      ["enclosure", "enclosure"],
      ["content:encoded", "contentEncoded"],
    ],
  },
});

const feed = await parser.parseURL("https://wornandwound.com/feed/");
const item = feed.items[0];

console.log("=== Item fields ===");
console.log("Has content:", !!item.content);
console.log("Has contentEncoded:", !!item.contentEncoded);
console.log("Has content:encoded:", !!item["content:encoded"]);
console.log("Content length:", (item.content || "").length);
console.log("ContentEncoded length:", (item.contentEncoded || "").length);

const html = item.content || item.contentEncoded || item["content:encoded"] || "";
const match = html.match(/<img[^>]+src=["']([^"']+)["']/i);
console.log("\n=== Image extraction ===");
console.log("Image found:", match ? match[1].substring(0, 100) : "none");
