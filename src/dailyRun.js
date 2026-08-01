#!/usr/bin/env node
// Daily batch runner — the path to a sustained ~1,000 leads/day.
//
// Reads a list of queries from config/daily-queries.json (falls back to the
// bundled .example.json), fans them out across Apify sources, dedupes against
// the persistent registry, enriches for emails, scores with the same Lead
// Intelligence engine as the dashboard, and saves everything to the database.
//
// Run manually:      npm run daily
// Or on a schedule:  0 6 * * *  cd /path/to/app && node src/dailyRun.js
//
// A DAILY_LEAD_CAP env var (default 1000) stops recording new leads once the
// quota is hit, so a broad query set can't run up an unbounded Apify bill.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const apifySources = require("./sources");
const { apifyEnrichLeads } = require("./sources/apifyEnrich");
const { enrichLeads } = require("./contactEnricher");
const LeadIntelligence = require("./leadIntelligence");
const LeadsDb = require("./leadsDb");
const LeadsRegistry = require("./leadsRegistry");
const LeadsRegistryDb = require("./leadsRegistryDb");

function loadQueries() {
  const primary = path.join(__dirname, "..", "config", "daily-queries.json");
  const example = path.join(
    __dirname,
    "..",
    "config",
    "daily-queries.example.json"
  );
  const file = fs.existsSync(primary) ? primary : example;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(parsed) ? parsed : parsed.queries || [];
    console.log(`[Daily] Loaded ${list.length} queries from ${path.basename(file)}`);
    return list;
  } catch (e) {
    console.error(`[Daily] Could not read query config: ${e.message}`);
    return [];
  }
}

function excludePatterns() {
  return (process.env.EXCLUDE_PAGES || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function applyExclude(leads, patterns) {
  if (!patterns.length) return leads;
  return leads.filter((l) => {
    const hay = `${l.name || ""} ${l.website || ""} ${l.pageUrl || ""}`.toLowerCase();
    return !patterns.some((p) => hay.includes(p));
  });
}

async function main() {
  const queries = loadQueries();
  if (!queries.length) {
    console.error("[Daily] No queries to run. Create config/daily-queries.json.");
    process.exit(1);
  }
  if (!apifySources.isConfigured()) {
    console.error(
      "[Daily] APIFY_TOKEN is not set. Add it to .env before running the daily batch."
    );
    process.exit(1);
  }

  const cap = parseInt(process.env.DAILY_LEAD_CAP || "1000", 10);
  const patterns = excludePatterns();
  const intelligence = new LeadIntelligence();
  const leadsDb = new LeadsDb();
  const registry = new LeadsRegistryDb(leadsDb, new LeadsRegistry());

  const totals = { scraped: 0, fresh: 0, withEmail: 0, saved: 0, errors: 0 };
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  for (const q of queries) {
    if (totals.saved >= cap) {
      console.log(`[Daily] Reached DAILY_LEAD_CAP (${cap}); stopping.`);
      break;
    }
    const source = q.source || "apify_ads";
    const src = apifySources.getSource(source);
    if (!src) {
      console.warn(`[Daily] Skipping "${q.query}" — unknown/unsupported source "${source}"`);
      continue;
    }

    const label = `${source}:"${q.query}"`;
    try {
      const remaining = cap - totals.saved;
      const maxResults = Math.min(q.maxResults || 100, remaining);

      console.log(`\n[Daily] ▶ ${label} (up to ${maxResults})`);
      let leads = await src.scrape({
        query: q.query,
        maxResults,
        country: q.country || "US",
        location: q.location,
        industry: q.industry || "professional",
      });
      totals.scraped += leads.length;

      leads = applyExclude(leads, patterns);

      const { fresh } = await registry.filterNew(leads);
      totals.fresh += fresh.length;
      console.log(`[Daily]   ${leads.length} scraped, ${fresh.length} new after dedup`);
      if (!fresh.length) continue;

      // Enrich for emails
      let enriched = fresh;
      if (q.enrich !== false && src.enrichable) {
        try {
          enriched =
            (process.env.ENRICH_PROVIDER || "auto") === "http"
              ? await enrichLeads(fresh, { concurrency: 4, maxUrlsPerLead: 4 })
              : await apifyEnrichLeads(fresh, { deepEnrich: true });
        } catch (e) {
          console.warn(`[Daily]   enrichment failed: ${e.message}`);
        }
      }

      const scored = await intelligence.scoreLeads(
        enriched,
        q.industry || "professional"
      );
      totals.withEmail += scored.filter((l) => l.email).length;

      const campaignId = `daily_${source}_${stamp}`;
      await leadsDb.saveCampaign({
        id: campaignId,
        name: `Daily ${source}`,
        industry: q.industry || "professional",
        location: q.location || q.country || "US",
        searchQuery: q.query,
        source,
        country: q.country || "US",
        executedAt: new Date().toISOString(),
        results: {
          totalLeads: scored.length,
          priorityLeads: scored.filter((l) => l.intelligence.priority === "HIGH").length,
          averageScore: scored.length
            ? Math.round(scored.reduce((s, l) => s + l.intelligence.score, 0) / scored.length)
            : 0,
        },
      });
      const dbResult = await leadsDb.saveLeads(scored, campaignId, `Daily ${source}`);
      await registry.recordMany(scored, campaignId);
      totals.saved += dbResult.added;
      console.log(
        `[Daily]   saved ${dbResult.added} new, ${dbResult.updated} updated ` +
          `(${scored.filter((l) => l.email).length} with email)`
      );
    } catch (err) {
      totals.errors++;
      console.error(`[Daily] ✖ ${label} failed: ${err.message}`);
    }
  }

  console.log(
    `\n[Daily] DONE — scraped ${totals.scraped}, ${totals.fresh} new, ` +
      `${totals.saved} saved to DB, ${totals.withEmail} with email, ${totals.errors} errors.`
  );
  try {
    await leadsDb.close();
  } catch { /* ignore */ }
  process.exit(0);
}

main().catch((err) => {
  console.error("[Daily] Fatal:", err);
  process.exit(1);
});
