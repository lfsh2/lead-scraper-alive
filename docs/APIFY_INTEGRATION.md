# Apify Integration Guide — Actors, API & Pricing

Documentation for scaling the lead scraper to **1,000 leads/day** using Apify actors instead of (or alongside) the built-in Puppeteer scraper.

Researched 2026-07-28. Prices are the actors' listed rates and can change — verify on the store page before committing to volume.

---

## 1. Getting started

### Account & token

There is no per-scraper key. One account token runs every actor in the store:

1. Create an account at [apify.com](https://apify.com) (free plan includes $5/month usage credit).
2. Copy your token: **Apify Console → Settings → API & Integrations → Personal API token**.
3. Add to `.env` (and to DigitalOcean's env-var UI — never commit it):

```bash
APIFY_TOKEN=apify_api_XXXXXXXXXXXXXXXXXXXX
```

### Platform plans

Pay-per-result actor charges are deducted from your plan's prepaid credit; overage is billed to the next invoice.

| Plan | Monthly cost | Included usage credit | Notes |
|---|---|---|---|
| Free | $0 | $5 | Fine for testing; access pauses when credit runs out |
| **Starter** | **$29** | **$29** | Recommended starting point; overage pay-as-you-go |
| Scale | $199 | $199 | Lower per-result rates on some actors |
| Business | $999 | $999 | Not needed at our volume |

---

## 2. The Apify API

Two ways to call it. The REST API needs no dependency; the client library handles polling and pagination for you.

### Option A — REST (no dependency)

```bash
# Run an actor and wait for results in one call (sync, up to 5 min):
curl -X POST \
  "https://api.apify.com/v2/acts/curious_coder~facebook-ads-library-scraper/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d @input.json
```

For longer runs, start async and poll:

```
POST https://api.apify.com/v2/acts/{actor}/runs?token=...        → { data: { id, defaultDatasetId } }
GET  https://api.apify.com/v2/actor-runs/{runId}?token=...       → status: SUCCEEDED | RUNNING | FAILED
GET  https://api.apify.com/v2/datasets/{datasetId}/items?token=...&format=json
```

Note: actor IDs use `~` instead of `/` in URLs (`curious_coder~facebook-ads-library-scraper`).

### Option B — official client (recommended)

```bash
npm install apify-client
```

```js
const { ApifyClient } = require('apify-client');
const client = new ApifyClient({ token: process.env.APIFY_TOKEN });

const run = await client
  .actor('curious_coder/facebook-ads-library-scraper')
  .call(input);                       // starts run, waits for finish

const { items } = await client
  .dataset(run.defaultDatasetId)
  .listItems();                       // the scraped results
```

---

## 3. Actor catalog

### 3.1 Facebook Ad Library Scraper — `curious_coder/facebook-ads-library-scraper` ⭐ PRIMARY

Drop-in replacement for `src/metaScraper.js`. Same data source (Meta Ad Library = businesses actively spending on ads = highest intent), but with proxies, maintenance, and reliability handled for us.

- **Price:** $0.75 / 1,000 ads (pay-per-event, no extra platform usage)
- **Track record:** 4.66★, 35k users, 100% run success, updated Jan 2026
- **Input:** Ad Library search URLs — supports country, keyword, active status, date range, sort

```json
{
  "urls": [
    { "url": "https://www.facebook.com/ads/library/?active_status=active&ad_type=all&country=US&q=%22christian%20life%20coach%22&search_type=keyword_unordered" }
  ],
  "count": 500,
  "scrapeAdDetails": true,
  "period": ""
}
```

- **Output per ad (40+ fields):** ad archive ID (→ our `libraryId`), page name, page ID, categories, creative text/images/videos, CTA link (→ our `destinationUrl`), start/end dates, platforms, impressions/spend where available.
- **Caveats:** bills **per ad, not per advertiser** — one coach may run 5–10 ads, so budget ~5× the unique-lead target and dedupe by `pageId`. Output has no page URL field — construct it as `https://www.facebook.com/{pageId}`. No email/phone — enrich separately (§3.3).

### 3.2 Official Facebook Ads Scraper — `apify/facebook-ads-scraper` (fallback)

Same data source, maintained by Apify itself. More expensive but includes the page URL directly, and `isDetailsPerAd` adds advertiser phone, address, and Instagram follower counts.

- **Price:** $5.80/1k (Free plan) · $5.00/1k (Starter) · $3.40–4.20/1k (Scale/Business)
- **Track record:** 4.26★, 29k users, 99% success
- **Use when:** curious_coder's actor breaks, or when the built-in advertiser details are worth 6× the price.

### 3.3 Facebook Pages Scraper — `apify/facebook-pages-scraper` (enrichment)

Feed it the deduped advertiser page URLs from 3.1 to get contact info — replaces most of `contactEnricher.js`.

- **Price:** $5.40 / 1,000 pages (first 500 free)
- **Track record:** 4.63★, 54k users
- **Input:** list of `https://www.facebook.com/{pageId}` URLs
- **Output:** **email, phone, website**, address, likes, followers, categories, rating, ad status
- **Cost control:** only run on *unique, new* pages (after registry dedup), never per ad.

### 3.4 Leads Finder — `code_crafter/leads-finder` (volume backbone)

Apollo-style B2B database query, not a live scrape. The cheapest guaranteed path to 1,000 contacts/day with emails already attached.

- **Price:** ~$1.50 / 1,000 leads (up to 100k per run)
- **Input filters:** job title (`"life coach"`, `"executive coach"`), keywords (`christian`, `faith`, `ministry`), location, industry, company size
- **Output:** name, **verified email**, LinkedIn URL, company, title, location (mobile numbers on paid plans)
- **Caveats:** B2B-database coverage of solo coaches is thinner than for corporate roles; "faith-based" filtering is approximate — pipe results through our existing Claude `faithSignal` scoring to rank them.

### 3.5 Google Maps Scraper — `compass/crawler-google-places` (geo sweep)

Replaces the broken `src/scraper.js` Google Maps path (whose selectors are Indonesian-market-specific and drop most US results).

- **Price:** $1.50 / 1,000 places + add-ons (contact/email enrichment, email verification — roughly $1–3/1k extra)
- **Track record:** 4.73★, 529k users — the most battle-tested actor in the store
- **Input:** search terms × locations (e.g. `"christian life coach"` × top-100 US metros)
- **Output:** name, website, phone, address, rating, hours; **email + social profiles** with the "Company contacts enrichment" add-on
- **Caveat:** ~120 places max per search query — volume comes from many term×city combinations.

### 3.6 Instagram discovery — `apify/instagram-search-scraper` + profile scrapers

Coaches are heavily concentrated on Instagram; many list booking links and emails in bios.

- **Search:** `apify/instagram-search-scraper` — $1.50/1k results ($2.30/1k on Starter), search profiles/hashtags by keyword, up to 250 results per keyword. 4.73★.
- **Profile + email:** `social-fetch/instagram-profile-scraper` — ~$1.00–1.20/1k profiles, 50+ fields including public/business email and bio links. Alternative: `logical_scrapers/instagram-profile-scraper` at $2/1k.
- **Niche shortcut:** `easy_scraper/instagram-leads-scraper` — $10/mo rental + usage; keyword→leads with emails in one step, but tiny user base (180 users) so treat as experimental.

### 3.7 Website contact extraction — `vdrmota/contact-info-scraper` (optional)

Crawls any URL list (e.g. the `destinationUrl` landing pages we already collect) for emails, phones, and 14 social platforms. $1.05/1k pages, 4.70★, 55k users. Cheaper per-page than 3.3 when the advertiser's own site is known — a managed replacement for `contactEnricher.js`.

---

## 4. Pricing comparison

| Actor | What 1 result is | Price /1,000 | Emails? | Phones? | Rating / users | Role |
|---|---|---|---|---|---|---|
| `curious_coder/facebook-ads-library-scraper` | 1 ad | **$0.75** | ✗ | ✗ | 4.66★ / 35k | **Primary discovery (high intent)** |
| `apify/facebook-ads-scraper` | 1 ad | $5.00 (Starter) | ✗ | ✓ (with details) | 4.26★ / 29k | Fallback for primary |
| `apify/facebook-pages-scraper` | 1 page | $5.40 | ✓ | ✓ | 4.63★ / 54k | Enrich unique advertisers |
| `vdrmota/contact-info-scraper` | 1 page crawled | $1.05 | ✓ | ✓ | 4.70★ / 55k | Enrich landing pages (cheaper alt) |
| `code_crafter/leads-finder` | 1 contact | **$1.50** | ✓ verified | paid plans | – (new; successor of 4.6★ actor) | **Volume backbone** |
| `compass/crawler-google-places` | 1 place | $1.50 (+add-ons) | ✓ add-on | ✓ | 4.73★ / 529k | Geo sweep |
| `apify/instagram-search-scraper` | 1 profile/hashtag | $1.50–2.30 | ✗ | ✗ | 4.73★ / 18k | IG discovery |
| `social-fetch/instagram-profile-scraper` | 1 profile | $1.00–1.20 | ✓ bio/business | ✗ | – | IG profile emails |

---

## 5. Implementation (built)

The integration is wired in. Files added/changed:

| File | Purpose |
|---|---|
| `src/apifyClient.js` | Dependency-free REST client — starts an actor run, polls to completion, pages the dataset. Throws a clear error when `APIFY_TOKEN` is missing. |
| `src/sources/apifyAdLibrary.js` | Primary source. Builds the Ad Library search URL, runs `curious_coder/...`, maps each ad to our lead shape, and **collapses ads to one lead per advertiser** (over-fetches 5× to compensate). |
| `src/sources/apifyEnrich.js` | Email-focused enrichment. Pass 1: Facebook Pages actor on unique advertiser pages. Pass 2: Contact Details actor on landing sites for leads still missing an email. |
| `src/sources/apifyLeadsFinder.js` | Volume backbone — Apollo-style verified emails by job title/location. |
| `src/sources/apifyGoogleMaps.js` | Geo sweep with contact enrichment. |
| `src/sources/apifyInstagram.js` | Instagram keyword discovery (bios often carry a business email). |
| `src/sources/index.js` | Source registry — the one place to add a new source. |
| `src/leadsRegistryDb.js` | **DB-backed dedup registry** (async) with the file registry as fallback. This is what makes dedup — and therefore 1000/day — survive DigitalOcean redeploys. |
| `src/leadsDb{Postgres,Sqlite}.js` | Added the `seen_leads` table + `seenExistingKeys/seenRecord/seenStats/seenReset`. |
| `src/dailyRun.js` | Batch runner over `config/daily-queries.json`; scrape → dedup → enrich → score → save, capped at `DAILY_LEAD_CAP`. |
| `src/apifySmokeTest.js` | `npm run apify:test` — one tiny scrape to verify the token/pipeline before spending on volume. |
| `src/web/server.js` | New `apify_*` sources routed in; enrichment provider selection; async registry; new dropdown labels. |
| `src/web/public/index.html` | Dashboard "Lead Source" dropdown now offers the Apify sources (default) above the legacy scraper. |

### Environment variables

`APIFY_TOKEN` (required for Apify sources), `APIFY_MAX_WAIT_SECS` (run timeout),
`ENRICH_PROVIDER` (`auto`/`apify`/`http`), `DAILY_LEAD_CAP`, and optional
`APIFY_*_ACTOR` overrides. See `.env.example`.

### How to run

```bash
# 1. Put your token in .env:            APIFY_TOKEN=apify_api_...
# 2. Verify it works (tiny paid scrape):
npm run apify:test
# 3. Dashboard: pick an "Apify" source, tick "Enrich contacts" for emails.
# 4. Daily volume: copy the example config, edit queries, then:
cp config/daily-queries.example.json config/daily-queries.json
npm run daily
# 5. Automate (cron), e.g. 6am daily:
#    0 6 * * *  cd /path/to/app && node src/dailyRun.js >> logs/daily.log 2>&1
```

### Notes / follow-ups

- Actor output field names can drift between versions; every mapper reads
  fields defensively via `pick()` with candidate paths, so a rename means
  editing only the candidate list in `src/sources/_helpers.js` or the mapper.
- `code_crafter/leads-finder` input keys vary by version — override the whole
  payload with `APIFY_LEADS_FINDER_INPUT` (JSON) if results come back empty.
- The `seen_leads` table is created automatically on first boot / first run.
- Still open from the audit (not addressed here): dashboard API auth, the
  live credentials in `.env.digitalocean`, and the prospect list in public git
  history. Those are security items, separate from scraping capability.