import ghostClient from "./src/services/ghost-client.js";

async function deleteDupes() {
  const res = await ghostClient.request("GET", "/posts/?filter=tag:news&limit=100&fields=id,title,slug,canonical_url,created_at");

  const byUrl = {};
  res.posts.forEach(p => {
    const url = p.canonical_url || p.slug;
    if (!byUrl[url]) byUrl[url] = [];
    byUrl[url].push(p);
  });

  const dupes = Object.entries(byUrl).filter(([url, posts]) => posts.length > 1);
  console.log("Found", dupes.length, "duplicate sets");

  let deleted = 0;
  for (const [url, posts] of dupes) {
    // Sort by created_at descending (newest first), keep newest, delete rest
    posts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const toDelete = posts.slice(1); // All except newest

    for (const post of toDelete) {
      console.log("Deleting:", post.id, "-", post.title.substring(0, 40));
      try {
        await ghostClient.request("DELETE", "/posts/" + post.id + "/");
        deleted++;
      } catch (e) {
        // DELETE returns empty body, ignore parse error
      }
    }
  }
  console.log("\nDeleted", deleted, "duplicate posts");
}

deleteDupes();
