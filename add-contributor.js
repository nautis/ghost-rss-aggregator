import jwt from "jsonwebtoken";
import config from "./src/config.js";

const [id, secret] = config.ghostAdminApiKey.split(":");
const keyId = id;
const secretBuffer = Buffer.from(secret, "hex");

function generateToken() {
  return jwt.sign({}, secretBuffer, {
    keyid: keyId,
    algorithm: "HS256",
    expiresIn: "5m",
    audience: "/admin/",
  });
}

async function request(method, endpoint, data = null) {
  const url = `${config.ghostUrl}/ghost/api/admin${endpoint}`;
  const token = generateToken();

  const options = {
    method,
    headers: {
      Authorization: `Ghost ${token}`,
      "Content-Type": "application/json",
    },
  };

  if (data) {
    options.body = JSON.stringify(data);
  }

  const response = await fetch(url, options);
  const responseData = await response.json();

  if (!response.ok) {
    console.error("Response:", JSON.stringify(responseData, null, 2));
    const errorMsg = responseData.errors?.[0]?.message || "Unknown error";
    throw new Error(`Ghost API error: ${errorMsg}`);
  }

  return responseData;
}

async function createContributor(name, email, website) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 50);

  console.log(`Creating contributor: ${name} (${slug})`);
  console.log(`Email: ${email}`);
  console.log(`Website: ${website}`);

  // First check if user already exists
  try {
    const existing = await request("GET", `/users/slug/${slug}/`);
    console.log(`User already exists with ID: ${existing.users[0].id}`);
    return existing.users[0];
  } catch (e) {
    // User doesn't exist, continue with creation
  }

  // Get all roles to find Contributor role
  const rolesResponse = await request("GET", "/roles/?limit=all");
  const contributorRole = rolesResponse.roles.find(r => r.name === "Contributor");

  if (!contributorRole) {
    console.error("Available roles:", rolesResponse.roles.map(r => r.name));
    throw new Error("Contributor role not found");
  }

  console.log(`Found Contributor role ID: ${contributorRole.id}`);

  // Create invitation for new contributor
  const inviteData = {
    invites: [{
      email: email,
      role_id: contributorRole.id,
    }]
  };

  console.log("Sending invitation...");
  const inviteResponse = await request("POST", "/invites/", inviteData);
  console.log("Invitation sent:", inviteResponse);

  // Note: The user won't be fully created until they accept the invitation
  // For RSS aggregator purposes, we need a different approach - directly creating a user

  // Let's try the users endpoint directly
  const userData = {
    users: [{
      name: name,
      email: email,
      slug: slug,
      website: website,
      roles: [{ id: contributorRole.id }],
      status: "inactive", // Staff users that never logged in
    }]
  };

  try {
    const userResponse = await request("POST", "/users/", userData);
    console.log("User created:", userResponse.users[0]);
    return userResponse.users[0];
  } catch (e) {
    console.log("Direct user creation failed:", e.message);
    console.log("The invitation has been sent - user will need to accept it.");
    console.log("Alternatively, create the user manually in Ghost Admin.");
  }
}

// Get contributor name from command line
const args = process.argv.slice(2);
if (args.length < 3) {
  console.log("Usage: node add-contributor.js <name> <email> <website>");
  console.log("Example: node add-contributor.js \"Perezcope\" \"perezcope@feeds.local\" \"https://perezcope.com\"");
  process.exit(1);
}

const [name, email, website] = args;
createContributor(name, email, website).catch(console.error);
