// One-shot check + migration for the leads database.
// Run after setting DATABASE_URL in .env:  npm run db:setup
// Connects, creates tables if needed, imports every campaign from output/,
// and prints totals. Safe to run repeatedly — dedup prevents duplicates.
const LeadsDb = require("./leadsDb");

(async () => {
  const db = new LeadsDb();
  try {
    await db.ready;
    console.log("✅ Database connection OK");
    const backfill = await db.backfillFromOutput();
    console.log(
      `📥 Imported from output/: ${backfill.campaigns} campaigns, ` +
        `${backfill.added} new leads, ${backfill.updated} already known`
    );
    const stats = await db.getStats();
    console.log("📊 Database now holds:");
    console.log(`   Leads:      ${stats.totalLeads}`);
    console.log(`   Campaigns:  ${stats.campaigns}`);
    console.log(`   With email: ${stats.withEmail}  With phone: ${stats.withPhone}`);
    console.log(`   Avg score:  ${stats.averageScore}`);
    console.log(`   Backend:    ${stats.dbPath}`);
  } catch (err) {
    console.error("❌ Database setup failed:", err.message);
    if (/password authentication/i.test(err.message)) {
      console.error(
        "   → Check the password in DATABASE_URL in your .env " +
          "(Supabase → Settings → Database). Percent-encode special characters."
      );
    } else if (/ENETUNREACH|ENOTFOUND|ETIMEDOUT/i.test(err.message)) {
      console.error(
        "   → Your network can't reach the direct Supabase host. Use the " +
          '"Session pooler" connection string from Supabase\'s Connect dialog instead.'
      );
    }
    process.exitCode = 1;
  } finally {
    await db.close();
  }
})();
