const fs = require("fs");
const path = require("path");

// Global persistent registry of every unique lead we've ever scraped.
// Lives at <repo>/data/seen-leads.json so it survives server restarts and
// covers all campaigns. Dedup is keyed by:
//   - libraryId          (Meta Ad Library — globally unique)
//   - pageUrl normalized (any FB/IG/web page — for Pages search + Maps website)
//   - name+location      (Google Maps fallback when no libraryId/pageUrl)
class LeadsRegistry {
  constructor(filePath) {
    this.filePath =
      filePath || path.join(__dirname, "..", "data", "seen-leads.json");
    this.byKey = new Map(); // dedupKey -> { firstSeenAt, campaignId, name }
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        if (Array.isArray(raw.entries)) {
          for (const e of raw.entries) {
            if (e.key) this.byKey.set(e.key, e);
          }
        }
        console.log(`[Registry] Loaded ${this.byKey.size} known leads`);
      } else {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      }
    } catch (err) {
      console.warn("[Registry] Load failed:", err.message);
    }
  }

  _save() {
    try {
      const entries = Array.from(this.byKey.values());
      fs.writeFileSync(
        this.filePath,
        JSON.stringify({ updatedAt: new Date().toISOString(), entries }, null, 2)
      );
    } catch (err) {
      console.warn("[Registry] Save failed:", err.message);
    }
  }

  static keysFor(lead) {
    const keys = [];
    const norm = (s) =>
      String(s || "")
        .toLowerCase()
        .trim()
        .replace(/^https?:\/\/(www\.)?/, "")
        .replace(/\/+$/, "")
        .replace(/\?.*$/, "");

    if (lead.libraryId) keys.push(`libraryId:${lead.libraryId}`);
    if (lead.pageUrl) keys.push(`page:${norm(lead.pageUrl)}`);
    if (lead.website) keys.push(`page:${norm(lead.website)}`);
    if (lead.name) {
      const n = lead.name.toLowerCase().trim().replace(/\s+/g, " ");
      if (lead.address) {
        const a = lead.address.toLowerCase().trim().replace(/\s+/g, " ");
        keys.push(`na:${n}|${a}`);
      } else {
        keys.push(`name:${n}`);
      }
    }
    return keys;
  }

  has(lead) {
    return LeadsRegistry.keysFor(lead).some((k) => this.byKey.has(k));
  }

  filterNew(leads) {
    const fresh = [];
    const skipped = [];
    for (const lead of leads) {
      if (this.has(lead)) skipped.push(lead);
      else fresh.push(lead);
    }
    return { fresh, skipped };
  }

  recordMany(leads, campaignId) {
    const now = new Date().toISOString();
    let added = 0;
    for (const lead of leads) {
      const keys = LeadsRegistry.keysFor(lead);
      if (!keys.length) continue;
      // Use the first key as primary; mirror entry under any secondary keys.
      const primary = keys[0];
      if (this.byKey.has(primary)) continue;
      const entry = {
        key: primary,
        name: lead.name || "",
        source: lead.source || "",
        firstSeenAt: now,
        campaignId: campaignId || "",
      };
      for (const k of keys) {
        if (!this.byKey.has(k)) this.byKey.set(k, entry);
      }
      added++;
    }
    if (added > 0) this._save();
    return added;
  }

  stats() {
    // De-duplicate entries by primary key for an honest "unique leads" count.
    const uniq = new Set();
    for (const e of this.byKey.values()) uniq.add(e.key);
    return { uniqueLeads: uniq.size, indexedKeys: this.byKey.size };
  }

  reset() {
    this.byKey.clear();
    this._save();
  }
}

module.exports = LeadsRegistry;
