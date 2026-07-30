// Geo sweep — Google Maps via Apify. Replaces the broken src/scraper.js Maps
// path (whose selectors were Indonesian-market-specific and dropped most US
// results).
//
// Actor: compass/crawler-google-places ($1.50 / 1,000 places + contact add-on).
// With scrapeContacts/enrichment on, returns email + socials alongside the
// standard name/website/phone/address.
//
// Volume comes from many term × city combinations (~120 places max per query),
// so the daily runner fans out across metros.

const { runActor } = require("../apifyClient");
const { pick, firstEmail, cleanPhone, toArray } = require("./_helpers");

const ACTOR_ID =
  process.env.APIFY_MAPS_ACTOR || "compass/crawler-google-places";

const COUNTRY_NAMES = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  NZ: "New Zealand",
  ZA: "South Africa",
};

function mapItem(item) {
  const emails = toArray(pick(item, ["emails", "email", "contactDetails.emails"]));
  const phones = toArray(
    pick(item, ["phones", "phone", "phoneUnformatted", "contactDetails.phones"])
  );
  return {
    name: pick(item, ["title", "name"]) || "",
    address: pick(item, ["address", "formattedAddress", "street"], ""),
    phone: cleanPhone(phones[0] || ""),
    rating: pick(item, ["totalScore", "rating"], ""),
    email: firstEmail(emails),
    website: pick(item, ["website", "url"], ""),
    pageUrl: pick(item, ["website", "url"], ""),
    description: pick(item, ["categoryName", "category"], ""),
    destinationUrl: pick(item, ["website"], ""),
    platforms: [],
    startedRunningOn: "",
    libraryId: "",
    adStatus: "",
    source: "Google Maps",
    hasWebsite: !!pick(item, ["website"], ""),
  };
}

async function scrape({ query, maxResults = 50, country = "US", location }) {
  if (!query) return [];
  const loc = location || COUNTRY_NAMES[country] || "United States";
  const input = {
    searchStringsArray: [query],
    locationQuery: loc,
    maxCrawledPlacesPerSearch: Math.min(maxResults, 120),
    language: "en",
    // Contact enrichment add-on (email + socials). Extra cost per place.
    scrapeContacts: true,
    maximumLeadsEnrichmentRecords: 1,
  };
  const items = await runActor(ACTOR_ID, input, {
    label: "Google Maps",
    maxItems: maxResults,
  });
  return items.map(mapItem).filter((l) => l.name);
}

module.exports = { scrape, mapItem, ACTOR_ID };
