import ghostClient from "./src/services/ghost-client.js";

const excerpts = {
  "6961d6cadd493139539413b2": "A review of Panerai's PAM01654 flyback chronograph from the Luna Rossa partnership - a 150-piece limited edition built for timing competitive sailing in the America's Cup.",
  "6961d6cadd493139539413b0": "Exploring the Longines Type A-7, a pilot's chronograph born from military necessity and cockpit urgency, now reissued as a tribute to aviation heritage."
};

async function addExcerpts() {
  for (const [id, excerpt] of Object.entries(excerpts)) {
    // Get current post for updated_at
    const current = await ghostClient.request("GET", `/posts/${id}/`);
    const post = current.posts[0];

    console.log("Updating:", post.title);
    console.log("  Excerpt:", excerpt);

    await ghostClient.request("PUT", `/posts/${id}/`, {
      posts: [{
        custom_excerpt: excerpt,
        updated_at: post.updated_at
      }]
    });
    console.log("  Done\n");
  }
}

addExcerpts();
