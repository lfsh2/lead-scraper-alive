require("dotenv").config();

// Leads database entry point. Picks the backend once at startup:
//   - DATABASE_URL (or SUPABASE_DB_URL) set  -> Postgres (Supabase)
//   - otherwise                              -> local SQLite at data/leads.db
// Both backends expose the same interface: saveCampaign, saveLeads, getLeads,
// exportLeads, getStats, backfillFromOutput, close.
const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL || "";
const looksConfigured = url && !url.includes("[YOUR-PASSWORD]");

if (url && !looksConfigured) {
  console.warn(
    "[LeadsDb] DATABASE_URL still contains the [YOUR-PASSWORD] placeholder — " +
      "falling back to local SQLite until you fill in your real database password."
  );
}

module.exports = looksConfigured
  ? require("./leadsDbPostgres")
  : require("./leadsDbSqlite");
