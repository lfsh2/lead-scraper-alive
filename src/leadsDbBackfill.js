const fs = require("fs");
const path = require("path");

// Import every existing campaign from the output/ directory into a leads
// database (SQLite or Postgres — anything with saveCampaign/saveLeads).
// Idempotent: dedup_key uniqueness means re-running never creates duplicates.
async function backfillFromOutput(db, outputDir) {
  const dir = outputDir || path.join(__dirname, "..", "output");
  if (!fs.existsSync(dir)) return { campaigns: 0, added: 0, updated: 0 };
  let totals = { campaigns: 0, added: 0, updated: 0 };
  const entries = fs
    .readdirSync(dir)
    .filter((d) => d.startsWith("campaign_"))
    .filter((d) => {
      try {
        return fs.statSync(path.join(dir, d)).isDirectory();
      } catch {
        return false;
      }
    });
  for (const d of entries) {
    try {
      const infoPath = path.join(dir, d, "campaign_info.json");
      const leadsPath = path.join(dir, d, "leads_with_intelligence.json");
      if (!fs.existsSync(leadsPath)) continue;
      const leads = JSON.parse(fs.readFileSync(leadsPath, "utf8"));
      let info = { id: d, name: d };
      if (fs.existsSync(infoPath)) {
        info = { ...JSON.parse(fs.readFileSync(infoPath, "utf8")), id: d };
      }
      await db.saveCampaign(info);
      const res = await db.saveLeads(leads, d, info.name || d);
      totals.campaigns++;
      totals.added += res.added;
      totals.updated += res.updated;
    } catch (err) {
      console.warn(`[LeadsDb] Backfill skipped ${d}: ${err.message}`);
    }
  }
  return totals;
}

module.exports = { backfillFromOutput };
