// Volume backbone — Apollo-style B2B database query via Apify.
// Actor: code_crafter/leads-finder (~$1.50 / 1,000 leads, verified emails).
//
// This is a DATABASE query, not a live scrape: the cheapest guaranteed path to
// filling a daily quota with contacts that already have emails attached.
// Coverage of solo faith-coaches is approximate, so results are still run
// through the Claude faithSignal scoring downstream to rank them.
//
// NOTE: leads-finder's exact input keys can change between versions. The input
// below is intentionally broad; override the whole payload with
// APIFY_LEADS_FINDER_INPUT (JSON) if the actor's schema differs.

const { runActor } = require("../apifyClient");
const { pick, firstEmail, cleanPhone } = require("./_helpers");

const ACTOR_ID =
  process.env.APIFY_LEADS_FINDER_ACTOR || "code_crafter/leads-finder";

const COUNTRY_NAMES = {
  US: "United States",
  GB: "United Kingdom",
  CA: "Canada",
  AU: "Australia",
  NZ: "New Zealand",
  ZA: "South Africa",
};

function buildInput({ query, maxResults, country, location, jobTitles }) {
  // Explicit override wins.
  if (process.env.APIFY_LEADS_FINDER_INPUT) {
    try {
      return JSON.parse(process.env.APIFY_LEADS_FINDER_INPUT);
    } catch {
      /* fall through to derived input */
    }
  }
  const loc = location || COUNTRY_NAMES[country] || "United States";
  const titles = jobTitles && jobTitles.length ? jobTitles : [query];
  return {
    job_titles: titles,
    person_titles: titles,
    locations: [loc],
    person_locations: [loc],
    q_keywords: query,
    max_results: maxResults,
    total_records: maxResults,
  };
}

function mapItem(item) {
  const name =
    pick(item, ["name", "full_name", "fullName"]) ||
    [pick(item, ["first_name", "firstName"]), pick(item, ["last_name", "lastName"])]
      .filter(Boolean)
      .join(" ")
      .trim();
  const website = pick(item, [
    "organization.website_url",
    "company_website",
    "website",
    "organization_website",
    "linkedin_url",
    "linkedinUrl",
  ]);
  return {
    name: name || "",
    address: pick(item, ["location", "city"], ""),
    phone: cleanPhone(pick(item, ["phone", "mobile", "phone_number", "sanitized_phone"])),
    rating: "",
    email: firstEmail(pick(item, ["email", "work_email", "personal_email"]), item.emails),
    website: website || "",
    pageUrl: pick(item, ["linkedin_url", "linkedinUrl"], ""),
    description: [
      pick(item, ["title", "headline", "job_title"]),
      pick(item, ["organization.name", "company", "organization_name"]),
    ]
      .filter(Boolean)
      .join(" @ "),
    destinationUrl: website && !/linkedin\.com/i.test(website) ? website : "",
    platforms: [],
    startedRunningOn: "",
    libraryId: "",
    adStatus: "",
    source: "Apollo / Leads Finder",
    hasWebsite: !!website,
  };
}

async function scrape({ query, maxResults = 50, country = "US", location, jobTitles }) {
  if (!query) return [];
  const input = buildInput({ query, maxResults, country, location, jobTitles });
  const items = await runActor(ACTOR_ID, input, {
    label: "Leads Finder",
    maxItems: maxResults,
  });
  return items.map(mapItem).filter((l) => l.name || l.email);
}

module.exports = { scrape, mapItem, buildInput, ACTOR_ID };
