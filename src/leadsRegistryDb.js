const LeadsRegistry = require("./leadsRegistry");

// Database-backed dedup registry with a file-based fallback.
//
// The old file registry (data/seen-leads.json) lived on the container's
// ephemeral disk, so dedup silently reset on every redeploy — which, once
// Apify removes the scraping bottleneck, is the binding constraint on hitting
// 1,000 leads/day. This facade keeps the same interface the server used
// (filterNew / recordMany / stats / reset) but persists to the leads database
// (Postgres on hosted deploys), so the registry survives restarts.
//
// If the DB is unavailable or a query throws, it degrades to the in-process
// file registry rather than failing a campaign.
class LeadsRegistryDb {
  constructor(db, fallback) {
    this.db = db;
    this.fallback = fallback || new LeadsRegistry();
  }

  static keysFor(lead) {
    return LeadsRegistry.keysFor(lead);
  }

  _dbReady() {
    return this.db && typeof this.db.seenExistingKeys === "function";
  }

  async _existingSet(keys) {
    const arr = await this.db.seenExistingKeys(keys);
    return new Set(arr);
  }

  async filterNew(leads) {
    if (!Array.isArray(leads) || leads.length === 0)
      return { fresh: [], skipped: [] };
    if (!this._dbReady()) return this.fallback.filterNew(leads);

    try {
      const allKeys = new Set();
      for (const lead of leads)
        for (const k of LeadsRegistry.keysFor(lead)) allKeys.add(k);

      const existing = await this._existingSet(Array.from(allKeys));
      const fresh = [];
      const skipped = [];
      const batchSeen = new Set(); // dedupe within this batch too

      for (const lead of leads) {
        const keys = LeadsRegistry.keysFor(lead);
        const seenBefore = keys.some(
          (k) => existing.has(k) || batchSeen.has(k)
        );
        if (seenBefore) {
          skipped.push(lead);
        } else {
          fresh.push(lead);
          keys.forEach((k) => batchSeen.add(k));
        }
      }
      return { fresh, skipped };
    } catch (err) {
      console.warn("[Registry] DB filterNew failed, using fallback:", err.message);
      return this.fallback.filterNew(leads);
    }
  }

  async recordMany(leads, campaignId) {
    if (!Array.isArray(leads) || leads.length === 0) return 0;
    if (!this._dbReady()) return this.fallback.recordMany(leads, campaignId);

    try {
      const rows = [];
      const primaries = [];
      const seenPrimary = new Set();
      for (const lead of leads) {
        const keys = LeadsRegistry.keysFor(lead);
        if (!keys.length) continue;
        const primary = keys[0];
        if (seenPrimary.has(primary)) continue;
        seenPrimary.add(primary);
        primaries.push(primary);
        keys.forEach((k, i) =>
          rows.push({
            key: k,
            isPrimary: i === 0,
            name: lead.name || "",
            source: lead.source || "",
            campaignId: campaignId || "",
          })
        );
      }
      if (!rows.length) return 0;

      const existing = await this._existingSet(primaries);
      const added = primaries.filter((k) => !existing.has(k)).length;
      await this.db.seenRecord(rows);
      return added;
    } catch (err) {
      console.warn("[Registry] DB recordMany failed, using fallback:", err.message);
      return this.fallback.recordMany(leads, campaignId);
    }
  }

  async stats() {
    if (!this._dbReady()) return this.fallback.stats();
    try {
      return await this.db.seenStats();
    } catch (err) {
      console.warn("[Registry] DB stats failed, using fallback:", err.message);
      return this.fallback.stats();
    }
  }

  async reset() {
    if (!this._dbReady()) return this.fallback.reset();
    try {
      await this.db.seenReset();
      return true;
    } catch (err) {
      console.warn("[Registry] DB reset failed, using fallback:", err.message);
      return this.fallback.reset();
    }
  }
}

module.exports = LeadsRegistryDb;
