// Apify source registry. Each entry exposes a uniform async interface:
//   scrape({ query, maxResults, country, location, industry }) -> Lead[]
//
// This is the abstraction the audit called for — adding a new lead source is
// now one entry here plus one dropdown option, with no changes to the scoring,
// dedup, enrichment, or persistence pipeline downstream.

const adLibrary = require("./apifyAdLibrary");
const leadsFinder = require("./apifyLeadsFinder");
const googleMaps = require("./apifyGoogleMaps");
const instagram = require("./apifyInstagram");
const { isConfigured } = require("../apifyClient");

// key -> { label, scrape, enrichable }
const SOURCES = {
  apify_ads: {
    label: "Meta Ad Library (Apify)",
    scrape: adLibrary.scrape,
    enrichable: true, // has FB page → Pages enrichment works well
  },
  apify_leads: {
    label: "Leads Finder (verified emails)",
    scrape: leadsFinder.scrape,
    enrichable: false, // emails already attached
  },
  apify_maps: {
    label: "Google Maps (Apify)",
    scrape: googleMaps.scrape,
    enrichable: true,
  },
  apify_instagram: {
    label: "Instagram (Apify)",
    scrape: instagram.scrape,
    enrichable: true,
  },
};

function isApifySource(key) {
  return Object.prototype.hasOwnProperty.call(SOURCES, key);
}

function getSource(key) {
  return SOURCES[key] || null;
}

function labels() {
  const out = {};
  for (const [k, v] of Object.entries(SOURCES)) out[k] = v.label;
  return out;
}

module.exports = { SOURCES, isApifySource, getSource, labels, isConfigured };
