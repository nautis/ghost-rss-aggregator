import ghostClient from "./src/services/ghost-client.js";

async function findDupes() {
  const res = await ghostClient.request("GET", "/posts/?filter=tag:news&limit=100&fields=id,title,slug,canonical_url");

  const byUrl = {};
  res.posts.forEach(p => {
    const url = p.canonical_url || p.slug;
    if (!byUrl[url]) byUrl[url] = [];
    byUrl[url].push(p);
  });

  const dupes = Object.entries(byUrl).filter(([url, posts]) => posts.length > 1);
  console.log("Found", dupes.length, "duplicate sets:\n");
  dupes.forEach(([url, posts]) => {
    console.log(posts[0].title.substring(0, 60));
    console.log("  URL:", url);
    posts.forEach(p => console.log("  ID:", p.id));
    console.log();
  });
}
findDupes();
