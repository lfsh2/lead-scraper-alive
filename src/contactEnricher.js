// Visits the external landing URLs inside each ad's creative and pulls
// phone/email from the destination site. Uses light HTTP + cheerio rather
// than a full browser per page — fast and good enough for "Contact" pages.

const cheerio = require("cheerio");
const { URL } = require("url");

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Match e.g. (555) 123-4567, +1 555-123-4567, 555.123.4567
const PHONE_RE = /(\+?\d[\d\s().-]{8,}\d)/g;
const URL_RE = /https?:\/\/[^\s"'<>)\]]+|www\.[^\s"'<>)\]]+/gi;

const SKIP_HOST = /facebook\.com|instagram\.com|m\.me|messenger\.com|fb\.me|fbcdn\.|t\.me|wa\.me|linkedin\.com|twitter\.com|x\.com|tiktok\.com|youtube\.com|youtu\.be|google\.com|amazon\.com/i;
const SKIP_EMAIL = /noreply|no-reply|example\.com|wixpress|wordpress\.com|squarespace\.com|sentry|cloudflare|googleapis|github/i;

function extractUrls(text) {
    if (!text) return [];
    const out = new Set();
    const matches = text.match(URL_RE) || [];
    for (let u of matches) {
        u = u.replace(/[.,;!?)]+$/, ""); // trim trailing punctuation
        if (!/^https?:/i.test(u)) u = "http://" + u;
        try {
            const url = new URL(u);
            if (!SKIP_HOST.test(url.hostname)) out.add(url.origin + url.pathname);
        } catch (_) {}
    }
    return Array.from(out);
}

function cleanPhone(raw) {
    if (!raw) return "";
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 9 || digits.length > 15) return "";
    return raw.trim();
}

async function fetchPage(url, timeoutMs = 8000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            redirect: "follow",
            signal: controller.signal,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                Accept:
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.9",
            },
        });
        if (!res.ok) return null;
        const ct = res.headers.get("content-type") || "";
        if (!/text\/html|application\/xhtml/i.test(ct)) return null;
        const text = await res.text();
        return text.length > 1500000 ? text.slice(0, 1500000) : text;
    } catch (e) {
        return null;
    } finally {
        clearTimeout(t);
    }
}

function extractContactsFromHtml(html) {
    if (!html) return { phones: [], emails: [] };

    let $;
    try {
        $ = cheerio.load(html);
    } catch (e) {
        return { phones: [], emails: [] };
    }

    const emails = new Set();
    const phones = new Set();

    // 1. JSON-LD structured data — most reliable signal on modern coach sites
    $('script[type="application/ld+json"]').each((_, el) => {
        try {
            const raw = $(el).contents().text().trim();
            if (!raw) return;
            const data = JSON.parse(raw);
            const walk = (node) => {
                if (!node) return;
                if (Array.isArray(node)) return node.forEach(walk);
                if (typeof node === "object") {
                    if (typeof node.email === "string" && !SKIP_EMAIL.test(node.email)) emails.add(node.email);
                    if (typeof node.telephone === "string") {
                        const p = cleanPhone(node.telephone);
                        if (p) phones.add(p);
                    }
                    if (typeof node.contactPoint === "object") walk(node.contactPoint);
                    if (typeof node.publisher === "object") walk(node.publisher);
                    Object.values(node).forEach(walk);
                }
            };
            walk(data);
        } catch (_) {}
    });

    // 2. mailto: / tel: anchors — second most reliable
    $('a[href^="mailto:"]').each((_, el) => {
        const href = $(el).attr("href") || "";
        const m = href.replace(/^mailto:/i, "").split("?")[0].trim();
        if (m && !SKIP_EMAIL.test(m)) emails.add(m);
    });
    $('a[href^="tel:"]').each((_, el) => {
        const href = $(el).attr("href") || "";
        const p = cleanPhone(href.replace(/^tel:/i, "").trim());
        if (p) phones.add(p);
    });

    // 3. Regex fallback over visible body text
    $("script, style, noscript, svg").remove();
    const text = $("body").text().slice(0, 250000);
    if (emails.size === 0) {
        for (const m of text.match(EMAIL_RE) || []) {
            if (!SKIP_EMAIL.test(m)) emails.add(m);
        }
    }
    if (phones.size === 0) {
        for (const m of text.match(PHONE_RE) || []) {
            const p = cleanPhone(m);
            if (p) phones.add(p);
        }
    }

    return {
        phones: Array.from(phones).slice(0, 5),
        emails: Array.from(emails).slice(0, 5),
    };
}

function domainFallbacks(url) {
    try {
        const u = new URL(url);
        const origin = u.origin;
        return [
            origin,
            origin + "/contact",
            origin + "/contact-us",
            origin + "/about",
        ];
    } catch (_) {
        return [];
    }
}

async function enrichLead(lead, { maxUrlsPerLead = 4, perPageTimeoutMs = 8000 } = {}) {
    // Step 1: seed URLs — explicit destination first, then creative, then website
    const seedUrls = [];
    if (lead.destinationUrl && !SKIP_HOST.test(lead.destinationUrl)) seedUrls.push(lead.destinationUrl);
    extractUrls(lead.description || lead.creative || "").forEach(u => seedUrls.push(u));
    if (lead.website && !SKIP_HOST.test(lead.website)) seedUrls.push(lead.website);

    // Step 2: build the visit list — primary URLs PLUS domain fallbacks
    const seen = new Set();
    const visitOrder = [];
    const push = (u) => {
        const key = u.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            visitOrder.push(u);
        }
    };
    for (const u of seedUrls) push(u);
    for (const u of seedUrls) {
        for (const fb of domainFallbacks(u)) push(fb);
    }

    if (visitOrder.length === 0) return { ...lead };

    const phones = new Set();
    const emails = new Set();
    let landingUrl = "";
    let visited = 0;

    for (const url of visitOrder) {
        if (visited >= maxUrlsPerLead) break;
        const html = await fetchPage(url, perPageTimeoutMs);
        visited++;
        if (!html) continue;
        if (!landingUrl) landingUrl = url;
        const contacts = extractContactsFromHtml(html);
        contacts.phones.forEach((p) => phones.add(p));
        contacts.emails.forEach((e) => emails.add(e));
        if (phones.size && emails.size) break; // got both, stop
    }

    const enriched = { ...lead };
    if (phones.size && !lead.phone) enriched.phone = Array.from(phones)[0];
    if (emails.size && !lead.email) enriched.email = Array.from(emails)[0];
    if (landingUrl && (!lead.website || /facebook\.com/i.test(lead.website))) {
        enriched.landingUrl = landingUrl;
    }
    enriched.enrichedPhones = Array.from(phones);
    enriched.enrichedEmails = Array.from(emails);
    return enriched;
}

async function enrichLeads(leads, opts = {}) {
    const concurrency = opts.concurrency || 4;
    const out = new Array(leads.length);
    let i = 0;
    let withContact = 0;

    async function worker() {
        while (i < leads.length) {
            const idx = i++;
            const lead = leads[idx];
            try {
                const enriched = await enrichLead(lead, opts);
                out[idx] = enriched;
                if (enriched.email || enriched.phone) withContact++;
            } catch (e) {
                out[idx] = lead;
            }
        }
    }

    await Promise.all(Array.from({ length: concurrency }, worker));
    console.log(
        `[Enricher] ${withContact}/${leads.length} leads now have phone or email`
    );
    return out;
}

module.exports = { enrichLeads, enrichLead, extractUrls };
