// Email-focused contact enrichment via Apify.
//
// Two passes, cheapest-effective first:
//   1) Facebook Pages Scraper on each unique advertiser page — returns the
//      email/phone/website the page publicly lists. Best hit rate for Meta
//      Ad Library leads (whose only identifier is a FB page).
//   2) Contact Details Scraper on the advertiser's own landing/destination
//      site for any lead STILL missing an email — catches coaches who publish
//      contact info on their site but not their FB page.
//
// Actors:
//   apify/facebook-pages-scraper   ($5.40 / 1,000 pages)
//   vdrmota/contact-info-scraper   ($1.05 / 1,000 pages)
//
// Cost control: dedupe pages first, and only run pass 2 on the residual set.

const { runActor, isConfigured } = require("../apifyClient");
const { pick, firstEmail, cleanPhone } = require("./_helpers");

const PAGES_ACTOR =
  process.env.APIFY_PAGES_ACTOR || "apify/facebook-pages-scraper";
const CONTACT_ACTOR =
  process.env.APIFY_CONTACT_ACTOR || "vdrmota/contact-info-scraper";

const isFb = (u) => /facebook\.com/i.test(String(u || ""));
const normUrl = (u) =>
  String(u || "")
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/+$/, "")
    .replace(/\?.*$/, "");

// ── Pass 1: Facebook Pages Scraper ───────────────────────────────────────────
async function enrichViaPages(leads) {
  const pageUrls = new Set();
  for (const l of leads) {
    const u = l.pageUrl || l.website;
    if (u && isFb(u)) pageUrls.add(u.split("?")[0]);
  }
  if (pageUrls.size === 0) return new Map();

  const urls = Array.from(pageUrls);
  const items = await runActor(
    PAGES_ACTOR,
    { startUrls: urls.map((url) => ({ url })) },
    { label: "FB Pages enrich", maxItems: urls.length }
  );

  // Index results by normalized page URL so we can merge back onto leads.
  const byUrl = new Map();
  for (const item of items) {
    const url = pick(item, ["pageUrl", "url", "facebookUrl", "pageAdLibrary.pageUrl"]);
    const key = normUrl(url);
    if (!key) continue;
    byUrl.set(key, {
      email: firstEmail(
        pick(item, ["email", "emails.0"]),
        item.emails
      ),
      phone: cleanPhone(pick(item, ["phone", "phoneNumber", "phones.0"])),
      website: pick(item, ["website", "websites.0", "link"]),
      address: pick(item, ["address", "addressStreet", "location"]),
      rating: pick(item, ["rating", "pageRating"], ""),
    });
  }
  return byUrl;
}

// ── Pass 2: Contact Details Scraper on landing sites ─────────────────────────
async function enrichViaContactSites(leads) {
  const sites = new Set();
  const chooseSite = (l) => {
    const cands = [l.destinationUrl, l.landingUrl, l.website];
    return cands.find((u) => u && !isFb(u)) || "";
  };
  for (const l of leads) {
    const site = chooseSite(l);
    if (site) sites.add(site.split("#")[0]);
  }
  if (sites.size === 0) return new Map();

  const urls = Array.from(sites);
  const items = await runActor(
    CONTACT_ACTOR,
    {
      startUrls: urls.map((url) => ({ url })),
      maxDepth: 1,
      maxRequestsPerStartUrl: 3,
    },
    { label: "Landing-page enrich", maxItems: urls.length * 3 }
  );

  const bySite = new Map();
  for (const item of items) {
    const url = pick(item, ["url", "originUrl", "domain"]);
    const key = normUrl(url).split("/")[0]; // index by host
    if (!key) continue;
    const email = firstEmail(item.emails, pick(item, ["email"]));
    const phone = cleanPhone(
      Array.isArray(item.phones) ? item.phones[0] : pick(item, ["phone"])
    );
    const prev = bySite.get(key) || { email: "", phone: "" };
    bySite.set(key, {
      email: prev.email || email,
      phone: prev.phone || phone,
    });
  }
  return bySite;
}

/**
 * Enrich leads with contact info via Apify. Fills only missing email/phone.
 * @returns {Promise<object[]>} enriched copy of leads
 */
async function apifyEnrichLeads(leads, opts = {}) {
  if (!isConfigured() || !Array.isArray(leads) || leads.length === 0) {
    return leads;
  }

  let withContact = 0;
  const out = leads.map((l) => ({ ...l }));

  // Pass 1 — FB pages
  let pageMap = new Map();
  try {
    pageMap = await enrichViaPages(out);
  } catch (e) {
    console.warn("[ApifyEnrich] pages pass failed:", e.message);
  }
  for (const lead of out) {
    const key = normUrl(lead.pageUrl || lead.website);
    const hit = pageMap.get(key);
    if (!hit) continue;
    if (!lead.email && hit.email) lead.email = hit.email;
    if (!lead.phone && hit.phone) lead.phone = hit.phone;
    if (hit.website && (!lead.website || isFb(lead.website)))
      lead.landingUrl = hit.website;
    if (!lead.address && hit.address) lead.address = hit.address;
    if (!lead.rating && hit.rating) lead.rating = String(hit.rating);
  }

  // Pass 2 — landing sites, only for leads still missing an email
  if (opts.deepEnrich !== false) {
    const residual = out.filter((l) => !l.email);
    if (residual.length) {
      let siteMap = new Map();
      try {
        siteMap = await enrichViaContactSites(residual);
      } catch (e) {
        console.warn("[ApifyEnrich] contact-site pass failed:", e.message);
      }
      for (const lead of out) {
        if (lead.email) continue;
        const site = [lead.destinationUrl, lead.landingUrl, lead.website].find(
          (u) => u && !isFb(u)
        );
        const hit = siteMap.get(normUrl(site).split("/")[0]);
        if (!hit) continue;
        if (!lead.email && hit.email) lead.email = hit.email;
        if (!lead.phone && hit.phone) lead.phone = hit.phone;
      }
    }
  }

  for (const lead of out) {
    lead.enrichedEmails = lead.email ? [lead.email] : [];
    lead.enrichedPhones = lead.phone ? [lead.phone] : [];
    if (lead.email || lead.phone) withContact++;
  }

  console.log(
    `[ApifyEnrich] ${withContact}/${out.length} leads now have phone or email`
  );
  return out;
}

module.exports = { apifyEnrichLeads, enrichViaPages, enrichViaContactSites };
