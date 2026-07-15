const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const LeadsRegistry = require("./leadsRegistry");
const { backfillFromOutput } = require("./leadsDbBackfill");

// Persistent SQLite store for every lead scraped across all campaigns.
// Lives at <repo>/data/leads.db (override with LEADS_DB_PATH).
// Dedup is enforced at the DB level via a UNIQUE dedup_key (same key scheme
// as LeadsRegistry), so re-saving the same lead upgrades its contact info
// instead of creating a duplicate row.
class LeadsDbSqlite {
  constructor(filePath) {
    this.filePath =
      filePath ||
      process.env.LEADS_DB_PATH ||
      path.join(__dirname, "..", "data", "leads.db");
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    this.db = new sqlite3.Database(this.filePath);
    this.ready = this._init();
  }

  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ changes: this.changes, lastID: this.lastID });
      });
    });
  }

  _get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  }

  _all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
    });
  }

  async _init() {
    await this._run(`CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY,
      name TEXT,
      industry TEXT,
      location TEXT,
      search_query TEXT,
      source TEXT,
      country TEXT,
      executed_at TEXT,
      total_leads INTEGER DEFAULT 0,
      priority_leads INTEGER DEFAULT 0,
      average_score INTEGER DEFAULT 0
    )`);
    await this._run(`CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key TEXT UNIQUE NOT NULL,
      campaign_id TEXT,
      campaign_name TEXT,
      name TEXT,
      source TEXT,
      email TEXT,
      phone TEXT,
      page_url TEXT,
      landing_url TEXT,
      website TEXT,
      address TEXT,
      rating TEXT,
      platforms TEXT,
      ad_status TEXT,
      started_running_on TEXT,
      library_id TEXT,
      creative TEXT,
      score INTEGER,
      priority TEXT,
      category TEXT,
      recommendation TEXT,
      raw_json TEXT,
      scraped_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
    await this._run(`CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id)`);
    await this._run(`CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score)`);
    await this._run(`CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(priority)`);
    console.log(`[LeadsDb] Ready at ${this.filePath}`);
  }

  async saveCampaign(info) {
    await this.ready;
    const r = info.results || {};
    await this._run(
      `INSERT INTO campaigns (id, name, industry, location, search_query, source, country,
        executed_at, total_leads, priority_leads, average_score)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         total_leads=excluded.total_leads,
         priority_leads=excluded.priority_leads,
         average_score=excluded.average_score,
         executed_at=excluded.executed_at`,
      [
        info.id,
        info.name || "",
        info.industry || "",
        info.location || "",
        info.searchQuery || "",
        info.source || "",
        info.country || "",
        info.executedAt || new Date().toISOString(),
        r.totalLeads || 0,
        r.priorityLeads || 0,
        r.averageScore || 0,
      ]
    );
  }

  // Insert (or upgrade) a batch of leads. Returns { added, updated }.
  async saveLeads(leads, campaignId, campaignName) {
    await this.ready;
    let added = 0;
    let updated = 0;
    for (const lead of leads) {
      const keys = LeadsRegistry.keysFor(lead);
      if (!keys.length) continue;
      const existing = await this._get(
        `SELECT 1 AS x FROM leads WHERE dedup_key = ?`,
        [keys[0]]
      );
      const intel = lead.intelligence || {};
      const params = [
        keys[0],
        campaignId || "",
        campaignName || "",
        lead.name || "",
        lead.source || "",
        lead.email || "",
        lead.phone || "",
        lead.pageUrl || "",
        lead.landingUrl || "",
        lead.website || "",
        lead.address || "",
        lead.rating != null ? String(lead.rating) : "",
        Array.isArray(lead.platforms) ? lead.platforms.join("; ") : lead.platforms || "",
        lead.adStatus || "",
        lead.startedRunningOn || "",
        lead.libraryId || "",
        lead.description || "",
        intel.score != null ? intel.score : null,
        intel.priority || "",
        intel.category || "",
        intel.recommendation || "",
        JSON.stringify(lead),
        lead.scrapedAt || new Date().toISOString(),
      ];
      await this._run(
        `INSERT INTO leads (dedup_key, campaign_id, campaign_name, name, source,
           email, phone, page_url, landing_url, website, address, rating,
           platforms, ad_status, started_running_on, library_id, creative,
           score, priority, category, recommendation, raw_json, scraped_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(dedup_key) DO UPDATE SET
           email     = CASE WHEN excluded.email     != '' THEN excluded.email     ELSE leads.email     END,
           phone     = CASE WHEN excluded.phone     != '' THEN excluded.phone     ELSE leads.phone     END,
           website   = CASE WHEN excluded.website   != '' THEN excluded.website   ELSE leads.website   END,
           landing_url = CASE WHEN excluded.landing_url != '' THEN excluded.landing_url ELSE leads.landing_url END,
           score     = COALESCE(excluded.score, leads.score),
           priority  = CASE WHEN excluded.priority  != '' THEN excluded.priority  ELSE leads.priority  END,
           raw_json  = excluded.raw_json`,
        params
      );
      if (existing) updated++;
      else added++;
    }
    return { added, updated };
  }

  _buildWhere(opts = {}) {
    const where = [];
    const params = [];
    if (opts.campaignId) {
      where.push("campaign_id = ?");
      params.push(opts.campaignId);
    }
    if (opts.priority) {
      where.push("priority = ?");
      params.push(String(opts.priority).toUpperCase());
    }
    if (opts.minScore) {
      where.push("score >= ?");
      params.push(parseInt(opts.minScore));
    }
    if (opts.source) {
      where.push("source = ?");
      params.push(opts.source);
    }
    if (opts.hasContact === true || opts.hasContact === "true") {
      where.push("(email != '' OR phone != '')");
    }
    if (opts.search) {
      where.push("(name LIKE ? OR email LIKE ? OR phone LIKE ? OR creative LIKE ?)");
      const q = `%${opts.search}%`;
      params.push(q, q, q, q);
    }
    return {
      whereSql: where.length ? `WHERE ${where.join(" AND ")}` : "",
      params,
    };
  }

  async getLeads(opts = {}) {
    await this.ready;
    const { whereSql, params } = this._buildWhere(opts);
    const limit = Math.min(parseInt(opts.limit) || 50, 500);
    const page = Math.max(parseInt(opts.page) || 1, 1);
    const offset = (page - 1) * limit;

    const countRow = await this._get(
      `SELECT COUNT(*) AS n FROM leads ${whereSql}`,
      params
    );
    const rows = await this._all(
      `SELECT * FROM leads ${whereSql}
       ORDER BY score DESC, created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    return {
      leads: rows,
      pagination: {
        page,
        limit,
        total: countRow.n,
        totalPages: Math.ceil(countRow.n / limit) || 1,
      },
    };
  }

  // Every matching row, no pagination — used for CSV export.
  async exportLeads(opts = {}) {
    await this.ready;
    const { whereSql, params } = this._buildWhere(opts);
    return this._all(
      `SELECT * FROM leads ${whereSql} ORDER BY score DESC, created_at DESC`,
      params
    );
  }

  async getStats() {
    await this.ready;
    const total = await this._get(`SELECT COUNT(*) AS n FROM leads`);
    const withEmail = await this._get(`SELECT COUNT(*) AS n FROM leads WHERE email != ''`);
    const withPhone = await this._get(`SELECT COUNT(*) AS n FROM leads WHERE phone != ''`);
    const avg = await this._get(`SELECT ROUND(AVG(score)) AS s FROM leads WHERE score IS NOT NULL`);
    const campaigns = await this._get(`SELECT COUNT(*) AS n FROM campaigns`);
    const byPriority = await this._all(
      `SELECT priority, COUNT(*) AS n FROM leads WHERE priority != '' GROUP BY priority`
    );
    const priorities = {};
    for (const r of byPriority) priorities[r.priority] = r.n;
    return {
      totalLeads: total.n,
      withEmail: withEmail.n,
      withPhone: withPhone.n,
      averageScore: avg.s || 0,
      campaigns: campaigns.n,
      byPriority: priorities,
      dbPath: this.filePath,
    };
  }

  async backfillFromOutput(outputDir) {
    await this.ready;
    return backfillFromOutput(this, outputDir);
  }

  close() {
    return new Promise((resolve) => this.db.close(() => resolve()));
  }
}

module.exports = LeadsDbSqlite;
