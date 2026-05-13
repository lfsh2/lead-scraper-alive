const puppeteer = require("puppeteer");

class MetaScraper {
  constructor() {
    this.browser = null;
    this.results = [];
    this.delay = (ms) => new Promise((r) => setTimeout(r, ms));
  }

  async init() {
    this.browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--window-size=1366,900",
      ],
    });
    console.log("[Meta] Browser initialized");
  }

  async newPage() {
    const page = await this.browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    );
    await page.setViewport({ width: 1366, height: 900 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
    return page;
  }

  // ─── Meta Ad Library ────────────────────────────────────────
  // Public, no auth. Best source for active marketers (coaches running ads).
  async scrapeAdLibrary(searchQuery, maxResults = 50, country = "US") {
    if (!this.browser) await this.init();
    const page = await this.newPage();

    const url =
      `https://www.facebook.com/ads/library/?active_status=all` +
      `&ad_type=all&country=${encodeURIComponent(country)}` +
      `&q=${encodeURIComponent(searchQuery)}&search_type=keyword_unordered`;
    console.log(`[Meta Ad Library] ${url}`);

    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await this.delay(3500);

      await this.dismissCookieBanner(page);

      // Scroll until enough ad cards loaded or no growth
      await this.scrollList(page, maxResults);

      // Build a slug → href map from every Facebook page link on the page —
      // we use this to recover the pageUrl once the text-split parser picks a name.
      const pageHrefIndex = await page.evaluate(() => {
        const idx = {};
        document.querySelectorAll('a[href*="facebook.com/"], a[href^="/"]').forEach((a) => {
          let href = a.getAttribute("href") || "";
          if (href.startsWith("/")) href = "https://www.facebook.com" + href;
          const label = (a.textContent || "").trim();
          if (!label || label.length < 2 || label.length > 80) return;
          if (
            href.includes("/ads/library") ||
            href.includes("/policies") ||
            href.includes("/help") ||
            href.includes("login") ||
            href.includes("signup") ||
            /Sponsored|Like|Follow|Learn More|Open Dropdown|See summary/i.test(label)
          )
            return;
          if (!idx[label]) idx[label] = href.split("?")[0];
        });
        return idx;
      });

      // For each Library ID, find the ad-card DOM and pluck the l.php CTA url
      // inside that card. This gives every lead its own destination URL —
      // i.e. the real coach website the ad is driving traffic to.
      const destByLibraryId = await page.evaluate(() => {
        const out = {};
        // Find every text node containing "Library ID: NNN"
        const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
          acceptNode: (n) =>
            /Library\s+ID:\s*\d+/i.test(n.nodeValue)
              ? NodeFilter.FILTER_ACCEPT
              : NodeFilter.FILTER_REJECT,
        });
        let tn;
        while ((tn = tw.nextNode())) {
          const m = tn.nodeValue.match(/Library\s+ID:\s*(\d+)/i);
          if (!m) continue;
          const libraryId = m[1];
          if (out[libraryId]) continue;

          // Walk up to the smallest ancestor that also contains "Sponsored"
          let card = tn.parentElement;
          for (let i = 0; i < 12 && card; i++) {
            if (/Sponsored/i.test(card.textContent || "")) break;
            card = card.parentElement;
          }
          if (!card) continue;

          const cta = card.querySelector('a[href*="l.facebook.com/l.php"]');
          if (cta) {
            try {
              const url = new URL(
                cta.getAttribute("href"),
                "https://www.facebook.com"
              );
              const dest = url.searchParams.get("u");
              if (dest) out[libraryId] = dest;
            } catch (_) {}
          }
        }
        return out;
      });

      // ── Text-based card splitter ────────────────────────────
      // The visual innerText of the Ad Library is a stream like:
      //    Inactive\nLibrary ID: 123\nMay 15, 2025 - Jun 20, 2025\n...
      // We split on each Library ID and parse each chunk as one ad.
      const pageInnerText = await page.evaluate(
        () => document.body.innerText || ""
      );

      const parsedAds = (() => {
        const out = [];
        const seenIds = new Set();
        const seenPages = new Set();

        // Split on Library ID boundaries
        const re = /Library\s+ID:\s*(\d+)/gi;
        const matches = [];
        let m;
        while ((m = re.exec(pageInnerText))) {
          matches.push({ id: m[1], index: m.index });
        }

        for (let i = 0; i < matches.length; i++) {
          const start = matches[i].index;
          const end =
            i + 1 < matches.length ? matches[i + 1].index : start + 4000;
          const chunk = pageInnerText.slice(start, end);
          const libraryId = matches[i].id;
          if (seenIds.has(libraryId)) continue;
          seenIds.add(libraryId);

          const lines = chunk
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);

          // Find page name = first line right before "Sponsored" that isn't UI chrome
          const sIdx = lines.findIndex((l) => /^Sponsored$/i.test(l));
          let pageName = "";
          if (sIdx > 0) {
            for (let k = sIdx - 1; k >= 0; k--) {
              const cand = lines[k];
              if (
                cand.length >= 2 &&
                cand.length < 80 &&
                !/Library ID|Started running|See summary|Open Dropdown|Platforms|ads use this|^Active$|^Inactive$/i.test(
                  cand
                ) &&
                !/^\d{1,3}\s+ads?\b/i.test(cand) &&
                !/^[A-Z][a-z]+\s+\d{1,2},\s*\d{4}/.test(cand)
              ) {
                pageName = cand;
                break;
              }
            }
          }
          if (!pageName) continue;
          const dedupeKey = pageName.toLowerCase();
          if (seenPages.has(dedupeKey)) continue;
          seenPages.add(dedupeKey);

          // Creative = lines AFTER "Sponsored", concatenated, capped
          let creative = "";
          if (sIdx >= 0) {
            const tail = lines.slice(sIdx + 1).filter((l) => {
              if (
                /Library ID|^Sponsored$|^Like$|^Follow$|^Learn More$|^Open Dropdown$|^See summary/i.test(
                  l
                )
              )
                return false;
              return true;
            });
            creative = tail.join(" ").slice(0, 800);
          }

          // Started running date
          let startedRunningOn = "";
          const dateMatch = chunk.match(
            /([A-Z][a-z]+\s+\d{1,2},\s*\d{4})\s*-\s*[A-Z][a-z]+\s+\d{1,2},\s*\d{4}/
          );
          const startedMatch = chunk.match(
            /Started running on\s*([A-Z][a-z]+\s+\d{1,2},\s*\d{4})/i
          );
          if (startedMatch) startedRunningOn = startedMatch[1];
          else if (dateMatch) startedRunningOn = dateMatch[1];

          // Platforms — Ad Library shows them as icon-titles, often as alt text.
          // The innerText sometimes contains "Facebook" / "Instagram" near the
          // "Platforms" label. We also infer "Instagram" if the page URL is on instagram.com.
          const platforms = [];
          const pIdx = lines.findIndex((l) => /^Platforms$/i.test(l));
          if (pIdx >= 0) {
            for (let k = pIdx + 1; k < Math.min(pIdx + 6, lines.length); k++) {
              const l = lines[k];
              if (/^Facebook$/i.test(l)) platforms.push("Facebook");
              if (/^Instagram$/i.test(l)) platforms.push("Instagram");
              if (/^Messenger$/i.test(l)) platforms.push("Messenger");
              if (/^Audience\s*Network$/i.test(l))
                platforms.push("Audience Network");
              if (
                /Library ID|^Sponsored$|^Active$|^Inactive$/i.test(l) &&
                k > pIdx + 1
              )
                break;
            }
          }

          // Status
          const status = /\bActive\b/.test(chunk) ? "Active" : "Inactive";

          // Resolve pageUrl from the link index
          const pageUrl = pageHrefIndex[pageName] || "";

          out.push({
            name: pageName,
            pageUrl,
            libraryId,
            startedRunningOn,
            creative,
            platforms,
            status,
            destinationUrl: destByLibraryId[libraryId] || "",
          });
        }
        return out;
      })();

      const ads = parsedAds;

      console.log(`[Meta Ad Library] Extracted ${ads.length} unique pages`);

      const normalized = ads.slice(0, maxResults).map((a) => ({
        name: a.name,
        address: "",
        phone: "",
        rating: "",
        website: a.pageUrl,
        referenceLink: `https://www.facebook.com/ads/library/?id=${a.libraryId}`,
        description: a.creative,
        destinationUrl: a.destinationUrl || "",
        platforms: a.platforms,
        startedRunningOn: a.startedRunningOn,
        libraryId: a.libraryId,
        adStatus: a.status,
        source: "Meta Ad Library",
        hasWebsite: true,
      }));

      this.results.push(...normalized);
      await page.close();
      return normalized;
    } catch (err) {
      console.error("[Meta Ad Library] Error:", err.message);
      try {
        await page.close();
      } catch (_) {}
      return [];
    }
  }

  // ─── Facebook Public Pages Search ───────────────────────────
  // Hits the public people/pages search results page. No login required for
  // the SERP itself, though some Pages may be gated.
  async scrapePagesSearch(searchQuery, maxResults = 30) {
    if (!this.browser) await this.init();
    const page = await this.newPage();
    const url = `https://www.facebook.com/public/${encodeURIComponent(
      searchQuery
    )}`;
    console.log(`[Meta Pages] ${url}`);

    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
      await this.delay(3000);
      await this.dismissCookieBanner(page);
      await this.scrollList(page, maxResults);

      const pages = await page.evaluate(() => {
        const out = [];
        const seen = new Set();
        const anchors = document.querySelectorAll(
          'a[href*="facebook.com/"], a[href^="/"][role="link"]'
        );
        anchors.forEach((a) => {
          const href = a.href || "";
          const text = (a.textContent || "").trim();
          if (!text || text.length < 2 || text.length > 80) return;
          if (
            href.includes("/login") ||
            href.includes("/signup") ||
            href.includes("/help") ||
            href.includes("/policies") ||
            href.includes("/ads/library")
          )
            return;
          // Heuristic: profile/page urls
          const m = href.match(/facebook\.com\/([^/?#]+)/);
          if (!m) return;
          const slug = m[1];
          if (
            !slug ||
            slug === "public" ||
            slug === "people" ||
            slug === "pages" ||
            seen.has(slug)
          )
            return;
          seen.add(slug);
          out.push({
            name: text,
            pageUrl: `https://www.facebook.com/${slug}`,
          });
        });
        return out;
      });

      console.log(`[Meta Pages] Extracted ${pages.length} candidates`);
      const normalized = pages.slice(0, maxResults).map((p) => ({
        name: p.name,
        address: "",
        phone: "",
        rating: "",
        website: p.pageUrl,
        referenceLink: p.pageUrl,
        description: "",
        platforms: ["Facebook"],
        source: "Facebook Pages",
        hasWebsite: true,
      }));
      this.results.push(...normalized);
      await page.close();
      return normalized;
    } catch (err) {
      console.error("[Meta Pages] Error:", err.message);
      try {
        await page.close();
      } catch (_) {}
      return [];
    }
  }

  // ─── Helpers ────────────────────────────────────────────────
  async dismissCookieBanner(page) {
    try {
      const buttons = await page.$$("button");
      for (const b of buttons) {
        const txt = (await page.evaluate((el) => el.textContent || "", b))
          .trim()
          .toLowerCase();
        if (
          txt.includes("allow all") ||
          txt.includes("accept all") ||
          txt.includes("only allow essential") ||
          txt.includes("decline optional")
        ) {
          await b.click().catch(() => {});
          await this.delay(800);
          break;
        }
      }
    } catch (_) {}
  }

  async scrollList(page, maxResults) {
    let prevHeight = 0;
    let stale = 0;
    for (let i = 0; i < 30; i++) {
      const h = await page.evaluate(() => {
        window.scrollBy(0, window.innerHeight);
        return document.body.scrollHeight;
      });
      await this.delay(1500);
      const count = await page.evaluate(
        () =>
          (
            document.body.textContent.match(/Library\s+ID:\s*\d+/gi) || []
          ).length
      );
      if (count >= maxResults) break;
      if (h === prevHeight) {
        stale++;
        if (stale >= 3) break;
      } else stale = 0;
      prevHeight = h;
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log("[Meta] Browser closed");
    }
  }
}

module.exports = MetaScraper;
