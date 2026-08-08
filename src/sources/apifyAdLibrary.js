// Facebook Ad Library via Apify — the reliable, precise replacement for the
// brittle Puppeteer scraper in src/metaScraper.js.
//
// Actor: curious_coder/facebook-ads-library-scraper ($0.75 / 1,000 ads).
// Apify handles proxies, headless detection, and DOM changes for us, so this
// is far more precise and doesn't silently return [] when Facebook pushes back.
//
// Same data source as before (advertisers = businesses actively spending on
// ads = highest intent). Output has no email/phone — enrich via apifyEnrich.js.

const { runActor } = require("../apifyClient");
const {
  pick,
  fbPageUrl,
  formatDate,
  truncate,
  toArray,
  dedupeByIdentity,
} = require("./_helpers");

const ACTOR_ID =
  process.env.APIFY_ADS_ACTOR || "curious_coder/facebook-ads-library-scraper";

// active_status: "active" is highest-intent (coach is spending right now).
// Override to "all" to include paused/expired ads.
function buildSearchUrl(query, country = "US", activeStatus = "active") {
  const params = new URLSearchParams({
    active_status: activeStatus,
    ad_type: "all",
    country: country || "US",
    q: query,
    search_type: "keyword_unordered",
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function mapItem(item) {
  const pageId = pick(item, [
    "page_id",
    "pageId",
    "snapshot.page_id",
    "snapshot.page_profile_id",
  ]);
  const pageName = pick(item, [
    "page_name",
    "pageName",
    "snapshot.page_name",
    "advertiser_name",
  ]);
  const explicitPageUrl = pick(item, [
    "page_url",
    "pageUrl",
    "snapshot.page_profile_uri",
    "snapshot.page_profile_url",
  ]);
  const pageUrl = fbPageUrl(explicitPageUrl || pageId);

  const libraryId = String(
    pick(item, [
      "ad_archive_id",
      "adArchiveID",
      "adArchiveId",
      "adArchiveId",
      "ad_id",
      "adId",
    ])
  );

  // Creative / body text — several shapes across actor versions.
  const description = truncate(
    pick(item, [
      "snapshot.body.text",
      "snapshot.body",
      "ad_creative_body",
      "adCreativeBody",
      "snapshot.caption",
      "body",
    ])
  );

  // Landing/CTA link — try the ad-level link, then the first creative card.
  let destinationUrl = pick(item, [
    "snapshot.link_url",
    "link_url",
    "snapshot.cards.0.link_url",
    "cta_link",
  ]);
  if (!destinationUrl) {
    const cards = toArray(pick(item, ["snapshot.cards", "cards"], []));
    if (cards.length) destinationUrl = cards[0].link_url || cards[0].url || "";
  }

  const isActive =
    pick(item, ["is_active", "isActive"], null) === true ||
    /active/i.test(pick(item, ["status", "ad_delivery_status"], ""));

  const platforms = toArray(
    pick(item, ["publisher_platform", "publisherPlatform", "platforms"], [])
  );

  const started = formatDate(
    pick(item, [
      "start_date",
      "startDate",
      "ad_delivery_start_time",
      "startDateFormatted",
    ])
  );

  const name = pageName || pick(item, ["advertiser_name"], "") || "";

  return {
    name,
    address: "",
    phone: "",
    rating: "",
    website: pageUrl, // FB page URL (parity with metaScraper)
    pageUrl, // populate BOTH so dedup + saveLeads work
    referenceLink: libraryId
      ? `https://www.facebook.com/ads/library/?id=${libraryId}`
      : "",
    description,
    destinationUrl: destinationUrl || "",
    platforms,
    startedRunningOn: started,
    libraryId: libraryId && libraryId !== "undefined" ? libraryId : "",
    adStatus: isActive ? "Active" : "Inactive",
    source: "Meta Ad Library",
    hasWebsite: !!pageUrl,
  };
}

/**
 * @param {object} args { query, maxResults, country, activeStatus }
 * @returns {Promise<object[]>} leads (deduped to one per advertiser page)
 */
async function scrape({ query, maxResults = 25, country = "US", activeStatus }) {
  if (!query) return [];

  // Actor bills per AD; one advertiser may run many ads. Over-fetch so that
  // after collapsing to one-per-advertiser we still net ~maxResults leads.
  // 3x is usually enough (most advertisers run 2-3 ads) and ~40% cheaper than
  // 5x — tune with APIFY_ADS_OVERFETCH.
  const overfetch = parseFloat(process.env.APIFY_ADS_OVERFETCH || '') || 3;
  const adFetch = Math.min(Math.max(Math.ceil(maxResults * overfetch), 50), 1000);

  const input = {
    urls: [
      { url: buildSearchUrl(query, country, activeStatus || "active"), method: "GET" },
    ],
    count: adFetch,
    "scrapePageAds.activeStatus": activeStatus || "active",
    scrapeAdDetails: true,
    period: "",
  };

  const items = await runActor(ACTOR_ID, input, {
    label: "FB Ad Library",
    maxItems: adFetch,
  });

  const mapped = items.map(mapItem).filter((l) => l.name);

  // One lead per advertiser (page). Prefer pageUrl, fall back to name.
  const deduped = dedupeByIdentity(
    mapped,
    (l) => (l.pageUrl || `name:${l.name}`).toLowerCase()
  );

  return deduped.slice(0, maxResults);
}

module.exports = { scrape, buildSearchUrl, mapItem, ACTOR_ID };
