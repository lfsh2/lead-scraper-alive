#!/usr/bin/env node
// Quick connectivity + mapping check for the Apify integration.
// Runs one tiny Ad Library scrape and prints the mapped leads so you can
// verify a real scrape works BEFORE spending on volume.
//
//   npm run apify:test                 # default query
//   node src/apifySmokeTest.js "christian life coach" US

require("dotenv").config();
const { isConfigured } = require("./apifyClient");
const adLibrary = require("./sources/apifyAdLibrary");

async function main() {
  if (!isConfigured()) {
    console.error(
      "\n✖ APIFY_TOKEN is not set.\n" +
        "  1. Create a free account at https://apify.com\n" +
        "  2. Copy your token: Console → Settings → API & Integrations\n" +
        "  3. Put it in .env as APIFY_TOKEN=...\n"
    );
    process.exit(1);
  }

  const query = process.argv[2] || "christian life coach";
  const country = process.argv[3] || "US";
  console.log(`\n▶ Test scrape: "${query}" (${country}) — up to 5 leads\n`);

  const t0 = Date.now();
  const leads = await adLibrary.scrape({ query, maxResults: 5, country });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  if (!leads.length) {
    console.log(
      `⚠ 0 leads returned in ${secs}s. Try a broader query, or check the ` +
        `Apify run log in your console for details.`
    );
    process.exit(0);
  }

  console.log(`✓ ${leads.length} leads in ${secs}s:\n`);
  for (const l of leads) {
    console.log(`• ${l.name}`);
    console.log(`    page:     ${l.pageUrl || "—"}`);
    console.log(`    landing:  ${l.destinationUrl || "—"}`);
    console.log(`    status:   ${l.adStatus}  |  libraryId: ${l.libraryId || "—"}`);
    console.log(`    started:  ${l.startedRunningOn || "—"}`);
    console.log("");
  }
  console.log(
    "Next: enable 'Enrich contacts' on a dashboard campaign (or run `npm run daily`) " +
      "to attach emails via the Facebook Pages actor.\n"
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("\n✖ Smoke test failed:", err.message);
  process.exit(1);
});
