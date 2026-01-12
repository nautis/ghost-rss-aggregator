import ghostClient from "./src/services/ghost-client.js";

const postData = {
  title: "Test Post with Image",
  html: "<p>Test content</p>",
  status: "draft",
  feature_image: "https://matthewclapp.com/content/images/2026/01/BMW-Joe-Ottati-2.jpg",
  custom_excerpt: "Test excerpt",
  canonical_url: "https://example.com/test",
  tags: [{ slug: "news" }],
};

console.log("Creating post with data:", JSON.stringify(postData, null, 2));

try {
  const result = await ghostClient.createPost(postData);
  console.log("Created post:", result.id, result.title);
  console.log("Feature image:", result.feature_image);
} catch (err) {
  console.error("Error:", err.message);
}
