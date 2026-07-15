const { Pool } = require("pg");
const LeadsRegistry = require("./leadsRegistry");
const { backfillFromOutput } = require("./leadsDbBackfill");

// Postgres (Supabase) store for every lead scraped across all campaigns.
// Same interface and dedup behavior as LeadsDbSqlite — the backend is chosen
// in leadsDb.js based on whether DATABASE_URL is set.
class LeadsDbPostgres {
  constructor(connectionString) {
    this.connectionString =
      connectionString ||
      process.env.DATABASE_URL ||
      process.env.SUPABASE_DB_URL;
    this.pool = new Pool({
      connectionString: this.connectionString,
      // Supabase requires SSL; its cert chain isn't in Node's default store.
      ssl: /localhost|127\.0\.0\.1/.test(this.connectionString || "")
        ? false
        : { rejectUnauthorized: false },
      max: 5,
    });
    // Without this, an error on an idle pooled connection (e.g. Supabase
    // dropping it after inactivity) crashes the whole process.
    this.pool.on("error", (err) =>
      console.warn(`[LeadsDb] Postgres pool error: ${err.message}`)
    );
    this.ready = this._init();
    // Surface init failures once instead of crashing on an unhandled rejection.
    this.ready.catch((err) =>
      console.error(`[LeadsDb] Postgres init failed: ${err.message}`)
    );
  }

  async _init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS campaigns (
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
    await this.pool.query(`CREATE TABLE IF NOT EXISTS leads (
      id SERIAL PRIMARY KEY,
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
      created_at TIMESTAMPTZ DEFAULT now()
    )`);
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_leads_campaign ON leads(campaign_id)`
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score)`
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS idx_leads_priority ON leads(priority)`
    );
    console.log(`[LeadsDb] Postgres ready (${this._safeHost()})`);
  }

  _safeHost() {
    try {
      return new URL(this.connectionString).host;
    } catch {
      return "postgres";
    }
  }

  async saveCampaign(info) {
    await this.ready;
    const r = info.results || {};
    await this.pool.query(
      `INSERT INTO campaigns (id, name, industry, location, search_query, source, country,
        executed_at, total_leads, priority_leads, average_score)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         total_leads=EXCLUDED.total_leads,
         priority_leads=EXCLUDED.priority_leads,
         average_score=EXCLUDED.average_score,
         executed_at=EXCLUDED.executed_at`,
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
        Array.isArray(lead.platforms)
          ? lead.platforms.join("; ")
          : lead.platforms || "",
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
      // xmax = 0 means the row was freshly inserted (not updated).
      const res = await this.pool.query(
        `INSERT INTO leads (dedup_key, campaign_id, campaign_name, name, source,
           email, phone, page_url, landing_url, website, address, rating,
           platforms, ad_status, started_running_on, library_id, creative,
           score, priority, category, recommendation, raw_json, scraped_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT (dedup_key) DO UPDATE SET
           email       = CASE WHEN EXCLUDED.email       != '' THEN EXCLUDED.email       ELSE leads.email       END,
           phone       = CASE WHEN EXCLUDED.phone       != '' THEN EXCLUDED.phone       ELSE leads.phone       END,
           website     = CASE WHEN EXCLUDED.website     != '' THEN EXCLUDED.website     ELSE leads.website     END,
           landing_url = CASE WHEN EXCLUDED.landing_url != '' THEN EXCLUDED.landing_url ELSE leads.landing_url END,
           score       = COALESCE(EXCLUDED.score, leads.score),
           priority    = CASE WHEN EXCLUDED.priority    != '' THEN EXCLUDED.priority    ELSE leads.priority    END,
           raw_json    = EXCLUDED.raw_json
         RETURNING (xmax = 0) AS inserted`,
        params
      );
      if (res.rows[0] && res.rows[0].inserted) added++;
      else updated++;
    }
    return { added, updated };
  }

  _buildWhere(opts = {}) {
    const where = [];
    const params = [];
    const next = () => `$${params.length}`;
    if (opts.campaignId) {
      params.push(opts.campaignId);
      where.push(`campaign_id = ${next()}`);
    }
    if (opts.priority) {
      params.push(String(opts.priority).toUpperCase());
      where.push(`priority = ${next()}`);
    }
    if (opts.minScore) {
      params.push(parseInt(opts.minScore));
      where.push(`score >= ${next()}`);
    }
    if (opts.source) {
      params.push(opts.source);
      where.push(`source = ${next()}`);
    }
    if (opts.hasContact === true || opts.hasContact === "true") {
      where.push(`(email != '' OR phone != '')`);
    }
    if (opts.search) {
      const q = `%${opts.search}%`;
      params.push(q);
      const p = next();
      where.push(
        `(name ILIKE ${p} OR email ILIKE ${p} OR phone ILIKE ${p} OR creative ILIKE ${p})`
      );
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

    const countRes = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM leads ${whereSql}`,
      params
    );
    const rowsRes = await this.pool.query(
      `SELECT * FROM leads ${whereSql}
       ORDER BY score DESC NULLS LAST, created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const total = countRes.rows[0].n;
    return {
      leads: rowsRes.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit) || 1,
      },
    };
  }

  // Every matching row, no pagination — used for CSV export.
  async exportLeads(opts = {}) {
    await this.ready;
    const { whereSql, params } = this._buildWhere(opts);
    const res = await this.pool.query(
      `SELECT * FROM leads ${whereSql} ORDER BY score DESC NULLS LAST, created_at DESC`,
      params
    );
    return res.rows;
  }

  async getStats() {
    await this.ready;
    const agg = await this.pool.query(`SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE email != '')::int AS with_email,
      COUNT(*) FILTER (WHERE phone != '')::int AS with_phone,
      COALESCE(ROUND(AVG(score) FILTER (WHERE score IS NOT NULL)), 0)::int AS avg_score
      FROM leads`);
    const campaigns = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM campaigns`
    );
    const byPriority = await this.pool.query(
      `SELECT priority, COUNT(*)::int AS n FROM leads WHERE priority != '' GROUP BY priority`
    );
    const priorities = {};
    for (const r of byPriority.rows) priorities[r.priority] = r.n;
    const a = agg.rows[0];
    return {
      totalLeads: a.total,
      withEmail: a.with_email,
      withPhone: a.with_phone,
      averageScore: a.avg_score,
      campaigns: campaigns.rows[0].n,
      byPriority: priorities,
      dbPath: `postgres://${this._safeHost()}`,
    };
  }

  async backfillFromOutput(outputDir) {
    await this.ready;
    return backfillFromOutput(this, outputDir);
  }

  close() {
    return this.pool.end();
  }
}

module.exports = LeadsDbPostgres;
