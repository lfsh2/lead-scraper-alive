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
    // Persistent dedup registry — survives redeploys (unlike data/seen-leads.json
    // on the ephemeral container disk). One row per dedup key; is_primary marks
    // the lead's canonical key so we can count unique leads honestly.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS seen_leads (
      key TEXT PRIMARY KEY,
      is_primary BOOLEAN DEFAULT false,
      name TEXT,
      source TEXT,
      campaign_id TEXT,
      first_seen_at TIMESTAMPTZ DEFAULT now()
    )`);
    // Outreach drafts + send log, keyed by the lead's dedup_key.
    await this.pool.query(`CREATE TABLE IF NOT EXISTS outreach (
      dedup_key TEXT PRIMARY KEY,
      to_email TEXT,
      subject TEXT,
      body TEXT,
      status TEXT,
      error TEXT,
      generated_at TIMESTAMPTZ,
      sent_at TIMESTAMPTZ
    )`);
    // Columns added after v1 — safe on existing tables.
    await this.pool.query(`ALTER TABLE outreach ADD COLUMN IF NOT EXISTS provider TEXT`);
    await this.pool.query(`ALTER TABLE outreach ADD COLUMN IF NOT EXISTS provider_id TEXT`);
    await this.pool.query(`ALTER TABLE outreach ADD COLUMN IF NOT EXISTS queued_at TIMESTAMPTZ`);
    await this.pool.query(`ALTER TABLE outreach ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`);
    await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_outreach_status ON outreach(status)`);
    console.log(`[LeadsDb] Postgres ready (${this._safeHost()})`);
  }

  // ── Outreach queue + activity log ────────────────────────────────────
  async enqueueOutreach(rows) {
    await this.ready;
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO outreach (dedup_key, to_email, subject, body, status, provider, queued_at, updated_at)
         VALUES ($1,$2,$3,$4,'queued',$5,now(),now())
         ON CONFLICT (dedup_key) DO UPDATE SET
           to_email = EXCLUDED.to_email, subject = EXCLUDED.subject, body = EXCLUDED.body,
           status = 'queued', provider = EXCLUDED.provider, error = '',
           queued_at = now(), updated_at = now()`,
        [r.key, r.to || "", r.subject || "", r.body || "", r.provider || ""]
      );
    }
  }

  async getQueuedOutreach(limit) {
    await this.ready;
    const res = await this.pool.query(
      `SELECT * FROM outreach WHERE status = 'queued' ORDER BY queued_at ASC NULLS FIRST LIMIT $1`,
      [Math.max(1, parseInt(limit) || 50)]
    );
    return res.rows;
  }

  async updateOutreachStatus(key, f = {}) {
    await this.ready;
    const sets = ["updated_at = now()"];
    const params = [];
    if (f.status !== undefined) { params.push(f.status); sets.push(`status = $${params.length}`); }
    if (f.providerId !== undefined) { params.push(f.providerId); sets.push(`provider_id = $${params.length}`); }
    if (f.error !== undefined) { params.push(f.error); sets.push(`error = $${params.length}`); }
    if (f.sentAt !== undefined) { params.push(f.sentAt); sets.push(`sent_at = $${params.length}`); }
    params.push(key);
    await this.pool.query(
      `UPDATE outreach SET ${sets.join(", ")} WHERE dedup_key = $${params.length}`,
      params
    );
  }

  async resetSendingToQueued() {
    await this.ready;
    await this.pool.query(
      `UPDATE outreach SET status = 'queued', updated_at = now() WHERE status = 'sending'`
    );
  }

  async getOutreachLog(opts = {}) {
    await this.ready;
    const where = [];
    const params = [];
    if (opts.status) { params.push(opts.status); where.push(`o.status = $${params.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(parseInt(opts.limit) || 50, 200);
    const page = Math.max(parseInt(opts.page) || 1, 1);
    const offset = (page - 1) * limit;
    const countRes = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM outreach o ${whereSql}`,
      params
    );
    const rowsRes = await this.pool.query(
      `SELECT o.*, l.name AS lead_name FROM outreach o
       LEFT JOIN leads l ON l.dedup_key = o.dedup_key
       ${whereSql}
       ORDER BY COALESCE(o.updated_at, o.generated_at) DESC NULLS LAST
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    const total = countRes.rows[0].n;
    return {
      rows: rowsRes.rows,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 },
    };
  }

  async getOutreachStats() {
    await this.ready;
    const res = await this.pool.query(
      `SELECT status, COUNT(*)::int AS n FROM outreach GROUP BY status`
    );
    const by = {};
    for (const r of res.rows) by[r.status || ""] = r.n;
    return by;
  }

  async getOutreachByKey(key) {
    await this.ready;
    const r = await this.pool.query(`SELECT * FROM outreach WHERE dedup_key = $1`, [key]);
    return r.rows[0] || null;
  }

  async getOutreachByProviderId(id) {
    await this.ready;
    const r = await this.pool.query(`SELECT * FROM outreach WHERE provider_id = $1`, [id]);
    return r.rows[0] || null;
  }

  // ── Outreach ─────────────────────────────────────────────────────────
  async getLeadsByKeys(keys) {
    await this.ready;
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const res = await this.pool.query(
      `SELECT * FROM leads WHERE dedup_key = ANY($1)`,
      [keys]
    );
    return res.rows;
  }

  async recordOutreach(rows) {
    await this.ready;
    if (!Array.isArray(rows) || rows.length === 0) return;
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO outreach (dedup_key, to_email, subject, body, status, error, generated_at, sent_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (dedup_key) DO UPDATE SET
           to_email = EXCLUDED.to_email,
           subject  = EXCLUDED.subject,
           body     = EXCLUDED.body,
           status   = EXCLUDED.status,
           error    = EXCLUDED.error,
           generated_at = COALESCE(EXCLUDED.generated_at, outreach.generated_at),
           sent_at  = COALESCE(EXCLUDED.sent_at, outreach.sent_at)`,
        [
          r.key,
          r.to || "",
          r.subject || "",
          r.body || "",
          r.status || "",
          r.error || "",
          r.generatedAt || null,
          r.sentAt || null,
        ]
      );
    }
  }

  async getSentKeys() {
    await this.ready;
    const res = await this.pool.query(
      `SELECT dedup_key FROM outreach
       WHERE status IN ('queued','sending','sent','delivered','opened')`
    );
    return res.rows.map((r) => r.dedup_key);
  }

  // ── Dedup registry (see src/leadsRegistryDb.js facade) ────────────────
  async seenExistingKeys(keys) {
    await this.ready;
    if (!Array.isArray(keys) || keys.length === 0) return [];
    const res = await this.pool.query(
      `SELECT key FROM seen_leads WHERE key = ANY($1)`,
      [keys]
    );
    return res.rows.map((r) => r.key);
  }

  async seenRecord(rows) {
    await this.ready;
    if (!Array.isArray(rows) || rows.length === 0) return;
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      slice.forEach((r, j) => {
        const b = j * 5;
        values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`);
        params.push(
          r.key,
          !!r.isPrimary,
          r.name || "",
          r.source || "",
          r.campaignId || ""
        );
      });
      await this.pool.query(
        `INSERT INTO seen_leads (key, is_primary, name, source, campaign_id)
         VALUES ${values.join(",")}
         ON CONFLICT (key) DO NOTHING`,
        params
      );
    }
  }

  async seenStats() {
    await this.ready;
    const r = await this.pool.query(
      `SELECT COUNT(*)::int AS indexed,
              COUNT(*) FILTER (WHERE is_primary)::int AS uniq
       FROM seen_leads`
    );
    return { uniqueLeads: r.rows[0].uniq, indexedKeys: r.rows[0].indexed };
  }

  async seenReset() {
    await this.ready;
    await this.pool.query(`DELETE FROM seen_leads`);
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
