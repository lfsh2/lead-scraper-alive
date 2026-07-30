// Instagram discovery — coaches cluster heavily on IG and often list a booking
// link and a business email in their bio.
//
// Actor: apify/instagram-search-scraper ($1.50–2.30 / 1,000 results).
// Searches profiles by keyword. Bios frequently contain a public business
// email; where they don't, the lead still carries the profile URL for the
// generic enrichment pass to work on.
//
// The "Instagram" source label routes these through the Meta scoring profile
// downstream (leadIntelligence keys on /Meta|Facebook|Instagram/i).

const { runActor } = require("../apifyClient");
const { pick, firstEmail, truncate } = require("./_helpers");

const ACTOR_ID =
  process.env.APIFY_IG_ACTOR || "apify/instagram-search-scraper";

function igUrl(username) {
  const u = String(username || "").replace(/^@/, "").trim();
  return u ? `https://www.instagram.com/${u}/` : "";
}

function mapItem(item) {
  const username = pick(item, ["username", "userName", "ownerUsername", "handle"]);
  const url = pick(item, ["url", "profileUrl"]) || igUrl(username);
  const bio = pick(item, ["biography", "bio"], "");
  return {
    name: pick(item, ["fullName", "full_name", "name"]) || username || "",
    address: "",
    phone: pick(item, ["businessPhoneNumber", "publicPhoneNumber"], ""),
    rating: "",
    email: firstEmail(
      pick(item, ["businessEmail", "public_email", "publicEmail"]),
      // Some actors surface a parsed email; otherwise the bio scan happens
      // downstream during enrichment.
      (bio.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/) || [])[0]
    ),
    website: url,
    pageUrl: url,
    description: truncate(bio, 500),
    destinationUrl: pick(item, ["externalUrl", "external_url", "website"], ""),
    platforms: ["Instagram"],
    startedRunningOn: "",
    libraryId: "",
    adStatus: "",
    source: "Instagram",
    hasWebsite: !!url,
  };
}

async function scrape({ query, maxResults = 50 }) {
  if (!query) return [];
  const input = {
    search: query,
    searchType: "user",
    searchLimit: Math.min(maxResults, 250),
  };
  const items = await runActor(ACTOR_ID, input, {
    label: "Instagram",
    maxItems: maxResults,
  });
  return items.map(mapItem).filter((l) => l.name);
}

module.exports = { scrape, mapItem, ACTOR_ID };
