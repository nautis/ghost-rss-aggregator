import ghostClient from "./src/services/ghost-client.js";

async function clearTemplates() {
  const res = await ghostClient.request("GET", "/posts/?filter=tag:[reviews,history]&limit=all&fields=id,title,custom_template");

  const withTemplate = res.posts.filter(p => p.custom_template);
  console.log("Found", withTemplate.length, "posts with custom templates");

  for (const post of withTemplate) {
    // Get fresh updated_at
    const current = await ghostClient.request("GET", `/posts/${post.id}/`);

    console.log("Clearing:", post.title.substring(0, 50));
    await ghostClient.request("PUT", `/posts/${post.id}/`, {
      posts: [{
        custom_template: "",
        updated_at: current.posts[0].updated_at
      }]
    });
  }

  console.log("\nCleared", withTemplate.length, "posts");
}

clearTemplates();
