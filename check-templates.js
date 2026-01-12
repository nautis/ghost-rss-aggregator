import ghostClient from "./src/services/ghost-client.js";

async function check() {
  const res = await ghostClient.request("GET", "/posts/?filter=tag:[reviews,history]&limit=all&fields=id,title,custom_template");

  const byTemplate = {};
  res.posts.forEach(p => {
    const t = p.custom_template || "(default)";
    if (!byTemplate[t]) byTemplate[t] = [];
    byTemplate[t].push(p.title);
  });

  Object.entries(byTemplate).forEach(([template, posts]) => {
    console.log(template + ":", posts.length, "posts");
    if (template !== "(default)") {
      posts.forEach(p => console.log("  -", p.substring(0, 50)));
    }
  });
}
check();
