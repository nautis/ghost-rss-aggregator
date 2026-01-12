import ghostClient from "./src/services/ghost-client.js";

async function getContent() {
  const res = await ghostClient.request("GET", "/posts/?filter=tag:[reviews,history]&limit=all&formats=html");

  const missing = res.posts.filter(p => !p.custom_excerpt);
  missing.forEach(p => {
    // Strip HTML and get first ~700 chars
    const text = (p.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    console.log("=== " + p.title + " ===");
    console.log("ID:", p.id);
    console.log("updated_at:", p.updated_at);
    console.log("Content preview:", text.substring(0, 700));
    console.log("");
  });
}
getContent();
