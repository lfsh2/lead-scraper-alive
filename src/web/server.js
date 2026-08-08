const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Import existing components
const BusinessScraper = require('../scraper');
const MetaScraper = require('../metaScraper');
const MarketingAutomation = require('../marketing');
const MarketingAI = require('../marketingAI');
const LeadIntelligence = require('../leadIntelligence');
const CampaignBuilder = require('../campaign');
const LeadsRegistry = require('../leadsRegistry');
const LeadsRegistryDb = require('../leadsRegistryDb');
const LeadsDb = require('../leadsDb');
const { enrichLeads } = require('../contactEnricher');
const { apifyEnrichLeads } = require('../sources/apifyEnrich');
const apifySources = require('../sources');
const mailer = require('../mailer');
const { startProcessor } = require('../outreachQueue');

const leadsDb = new LeadsDb();
// Database-backed dedup registry (survives redeploys); falls back to the
// legacy file registry if the DB is unavailable.
const leadsRegistry = new LeadsRegistryDb(leadsDb, new LeadsRegistry());

// One-time import of any pre-database campaigns sitting in output/.
// Idempotent (unique dedup_key), so running it on every boot is safe.
leadsDb.backfillFromOutput()
    .then(r => {
        if (r.added > 0 || r.updated > 0) {
            console.log(`[LeadsDb] Backfilled ${r.campaigns} campaigns: ${r.added} new leads, ${r.updated} updated`);
        }
    })
    .catch(err => console.warn('[LeadsDb] Backfill failed:', err.message));

// Start the background outreach send queue (no-op in manual mode).
startProcessor(leadsDb, (data) => broadcastSSE(data));

const app = express();
const PORT = process.env.PORT || process.env.WEB_PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Store for active campaigns and SSE connections
const activeCampaigns = new Map();
const sseConnections = new Set();

// Utility function to load user preferences
function loadUserPreferences() {
    try {
        if (fs.existsSync('user-preferences.json')) {
            return JSON.parse(fs.readFileSync('user-preferences.json', 'utf8'));
        }
    } catch (error) {
        console.log('Could not load user preferences:', error.message);
    }
    return null;
}

// Utility function to get campaign data from output directory
function getCampaignData() {
    const outputDir = path.join(__dirname, '../../output');
    if (!fs.existsSync(outputDir)) {
        return [];
    }

    const campaigns = [];
    const campaignDirs = fs.readdirSync(outputDir).filter(dir => 
        fs.statSync(path.join(outputDir, dir)).isDirectory() && dir.startsWith('campaign_')
    );

    for (const dir of campaignDirs) {
        const campaignPath = path.join(outputDir, dir);
        const infoPath = path.join(campaignPath, 'campaign_info.json');
        
        if (fs.existsSync(infoPath)) {
            try {
                const campaignInfo = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
                campaignInfo.id = dir;
                campaignInfo.path = campaignPath;
                campaigns.push(campaignInfo);
            } catch (error) {
                console.log(`Error reading campaign info for ${dir}:`, error.message);
            }
        }
    }

    // Sort by execution date (newest first)
    campaigns.sort((a, b) => new Date(b.executedAt) - new Date(a.executedAt));
    return campaigns;
}

// Utility function to get leads data from a campaign
function getLeadsData(campaignId) {
    const campaignPath = path.join(__dirname, '../../output', campaignId);
    const leadsPath = path.join(campaignPath, 'leads_with_intelligence.json');
    
    if (fs.existsSync(leadsPath)) {
        try {
            return JSON.parse(fs.readFileSync(leadsPath, 'utf8'));
        } catch (error) {
            console.log(`Error reading leads data for ${campaignId}:`, error.message);
        }
    }
    return [];
}

// SSE endpoint for real-time updates
app.get('/api/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
    });

    // Add connection to active connections
    sseConnections.add(res);

    // Send initial connection message
    res.write(`data: ${JSON.stringify({ type: 'connected', message: 'Connected to real-time updates' })}\n\n`);

    // Handle client disconnect
    req.on('close', () => {
        sseConnections.delete(res);
    });
});

// Function to broadcast SSE message to all connected clients
function broadcastSSE(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    sseConnections.forEach(res => {
        try {
            res.write(message);
        } catch (error) {
            sseConnections.delete(res);
        }
    });
}

// API Routes

// Dashboard overview
app.get('/api/dashboard', (req, res) => {
    try {
        const campaigns = getCampaignData();
        const userPrefs = loadUserPreferences();
        
        // Calculate overview statistics
        const totalCampaigns = campaigns.length;
        const totalLeads = campaigns.reduce((sum, campaign) => 
            sum + (campaign.results?.totalLeads || 0), 0);
        const totalPriorityLeads = campaigns.reduce((sum, campaign) => 
            sum + (campaign.results?.priorityLeads || 0), 0);
        const averageScore = campaigns.length > 0 ? 
            Math.round(campaigns.reduce((sum, campaign) => 
                sum + (campaign.results?.averageScore || 0), 0) / campaigns.length) : 0;

        // Recent activity (last 5 campaigns)
        const recentActivity = campaigns.slice(0, 5).map(campaign => ({
            id: campaign.id,
            name: campaign.name,
            type: campaign.type,
            industry: campaign.industry,
            executedAt: campaign.executedAt,
            totalLeads: campaign.results?.totalLeads || 0,
            priorityLeads: campaign.results?.priorityLeads || 0
        }));

        res.json({
            overview: {
                totalCampaigns,
                totalLeads,
                totalPriorityLeads,
                averageScore,
                primaryIndustry: userPrefs?.industry || 'professional'
            },
            recentActivity,
            userPreferences: userPrefs
        });
    } catch (error) {
        console.error('Error getting dashboard data:', error);
        res.status(500).json({ error: 'Failed to load dashboard data' });
    }
});

// Get all campaigns
app.get('/api/campaigns', (req, res) => {
    try {
        const campaigns = getCampaignData();
        res.json(campaigns);
    } catch (error) {
        console.error('Error getting campaigns:', error);
        res.status(500).json({ error: 'Failed to load campaigns' });
    }
});

// Get specific campaign details
app.get('/api/campaigns/:id', (req, res) => {
    try {
        const campaigns = getCampaignData();
        const campaign = campaigns.find(c => c.id === req.params.id);
        
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        // Get leads data for this campaign
        const leads = getLeadsData(req.params.id);
        campaign.leads = leads;

        res.json(campaign);
    } catch (error) {
        console.error('Error getting campaign details:', error);
        res.status(500).json({ error: 'Failed to load campaign details' });
    }
});

// Get leads for a specific campaign
app.get('/api/campaigns/:id/leads', (req, res) => {
    try {
        const leads = getLeadsData(req.params.id);
        const { page = 1, limit = 20, priority, minScore } = req.query;
        
        let filteredLeads = leads;
        
        // Apply filters
        if (priority) {
            filteredLeads = filteredLeads.filter(lead => 
                lead.intelligence?.priority === priority.toUpperCase()
            );
        }
        
        if (minScore) {
            filteredLeads = filteredLeads.filter(lead => 
                (lead.intelligence?.score || 0) >= parseInt(minScore)
            );
        }

        // Pagination
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + parseInt(limit);
        const paginatedLeads = filteredLeads.slice(startIndex, endIndex);

        res.json({
            leads: paginatedLeads,
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total: filteredLeads.length,
                totalPages: Math.ceil(filteredLeads.length / limit)
            }
        });
    } catch (error) {
        console.error('Error getting leads:', error);
        res.status(500).json({ error: 'Failed to load leads' });
    }
});

// Analytics endpoint
app.get('/api/analytics', (req, res) => {
    try {
        const campaigns = getCampaignData();
        
        // Industry distribution
        const industryStats = {};
        campaigns.forEach(campaign => {
            const industry = campaign.industry || 'unknown';
            if (!industryStats[industry]) {
                industryStats[industry] = { campaigns: 0, totalLeads: 0, avgScore: 0 };
            }
            industryStats[industry].campaigns++;
            industryStats[industry].totalLeads += campaign.results?.totalLeads || 0;
            industryStats[industry].avgScore += campaign.results?.averageScore || 0;
        });

        // Calculate averages
        Object.keys(industryStats).forEach(industry => {
            industryStats[industry].avgScore = Math.round(
                industryStats[industry].avgScore / industryStats[industry].campaigns
            );
        });

        // Lead quality distribution
        const qualityDistribution = { HIGH: 0, MEDIUM: 0, LOW: 0 };
        campaigns.forEach(campaign => {
            const leads = getLeadsData(campaign.id);
            leads.forEach(lead => {
                const priority = lead.intelligence?.priority || 'LOW';
                qualityDistribution[priority]++;
            });
        });

        // Campaign performance over time (last 30 days)
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        
        const recentCampaigns = campaigns.filter(campaign => 
            new Date(campaign.executedAt) >= thirtyDaysAgo
        );

        res.json({
            industryStats,
            qualityDistribution,
            campaignTrends: {
                totalCampaigns: campaigns.length,
                recentCampaigns: recentCampaigns.length,
                totalLeads: campaigns.reduce((sum, c) => sum + (c.results?.totalLeads || 0), 0),
                avgQualityScore: campaigns.length > 0 ? 
                    Math.round(campaigns.reduce((sum, c) => sum + (c.results?.averageScore || 0), 0) / campaigns.length) : 0
            }
        });
    } catch (error) {
        console.error('Error getting analytics:', error);
        res.status(500).json({ error: 'Failed to load analytics' });
    }
});

// vCard generation utility function
function generateVCard(lead) {
    const name = lead.name || 'Unknown Business';
    const phone = lead.phone || '';
    const address = lead.address || '';
    const website = lead.website || '';
    const rating = lead.rating || '';
    
    // Clean phone number for vCard format
    const cleanPhone = phone.replace(/[^\d+]/g, '');
    
    const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${name}`,
        `ORG:${name}`,
        cleanPhone ? `TEL:${cleanPhone}` : '',
        address ? `ADR:;;${address};;;;` : '',
        website ? `URL:${website}` : '',
        rating ? `NOTE:Google Rating: ${rating} stars` : '',
        lead.intelligence ? `NOTE:Lead Score: ${lead.intelligence.score}/100 - Priority: ${lead.intelligence.priority}` : '',
        'END:VCARD'
    ].filter(line => line !== '').join('\r\n');
    
    return vcard;
}

// Export single lead as vCard
app.get('/api/leads/:campaignId/:leadIndex/vcard', (req, res) => {
    try {
        const { campaignId, leadIndex } = req.params;
        const leads = getLeadsData(campaignId);
        const lead = leads[parseInt(leadIndex)];
        
        if (!lead) {
            return res.status(404).json({ error: 'Lead not found' });
        }
        
        const vcard = generateVCard(lead);
        const filename = `${(lead.name || 'contact').replace(/[^a-zA-Z0-9]/g, '_')}.vcf`;
        
        res.setHeader('Content-Type', 'text/vcard');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(vcard);
        
    } catch (error) {
        console.error('Error generating vCard:', error);
        res.status(500).json({ error: 'Failed to generate vCard' });
    }
});

// Export all leads from campaign as vCard bundle
app.get('/api/campaigns/:id/export/vcard', (req, res) => {
    try {
        const leads = getLeadsData(req.params.id);
        const campaigns = getCampaignData();
        const campaign = campaigns.find(c => c.id === req.params.id);
        
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        // Generate combined vCard file
        const vcards = leads.map(lead => generateVCard(lead)).join('\r\n\r\n');
        const filename = `${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}_contacts.vcf`;
        
        res.setHeader('Content-Type', 'text/vcard');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(vcards);
        
    } catch (error) {
        console.error('Error generating vCard bundle:', error);
        res.status(500).json({ error: 'Failed to generate vCard bundle' });
    }
});

// ─── CSV Export ─────────────────────────────────────────────
function toCsvCell(value) {
    if (value === null || value === undefined) return '';
    let s = Array.isArray(value) ? value.join('; ') : String(value);
    s = s.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.includes('"') || s.includes(',') || s.includes(';')) {
        s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

function leadsToCsv(leads, campaignName = '') {
    const headers = [
        'campaign', 'name', 'source', 'score', 'priority', 'category',
        'email', 'phone', 'page_url', 'landing_url', 'website',
        'address', 'rating',
        'platforms', 'ad_status', 'started_running_on', 'library_id',
        'creative', 'recommendation', 'scraped_at'
    ];
    const rows = [headers.join(',')];
    for (const l of leads) {
        const intel = l.intelligence || {};
        rows.push([
            toCsvCell(campaignName),
            toCsvCell(l.name),
            toCsvCell(l.source),
            toCsvCell(intel.score),
            toCsvCell(intel.priority),
            toCsvCell(intel.category),
            toCsvCell(l.email),
            toCsvCell(l.phone),
            toCsvCell(l.pageUrl || l.website),
            toCsvCell(l.landingUrl),
            toCsvCell(l.website),
            toCsvCell(l.address),
            toCsvCell(l.rating),
            toCsvCell(l.platforms),
            toCsvCell(l.adStatus),
            toCsvCell(l.startedRunningOn),
            toCsvCell(l.libraryId),
            toCsvCell(l.description),
            toCsvCell(intel.recommendation),
            toCsvCell(l.scrapedAt)
        ].join(','));
    }
    return rows.join('\r\n');
}

// Build CSV directly from database rows (canonical, deduplicated, latest
// values) — the accurate source of truth for exports. Every stored field is
// included so nothing scraped is lost.
function dbRowsToCsv(rows) {
    const headers = [
        'name', 'source', 'score', 'priority', 'category',
        'email', 'phone', 'website', 'page_url', 'landing_url',
        'address', 'rating',
        'platforms', 'ad_status', 'started_running_on', 'library_id',
        'creative', 'recommendation', 'campaign', 'date_added', 'dedup_key'
    ];
    const fmtDate = (v) => {
        if (!v) return '';
        const d = v instanceof Date ? v : new Date(v);
        return isNaN(d.getTime()) ? String(v) : d.toISOString();
    };
    const out = [headers.join(',')];
    for (const r of rows) {
        out.push([
            toCsvCell(r.name),
            toCsvCell(r.source),
            toCsvCell(r.score),
            toCsvCell(r.priority),
            toCsvCell(r.category),
            toCsvCell(r.email),
            toCsvCell(r.phone),
            toCsvCell(r.website),
            toCsvCell(r.page_url),
            toCsvCell(r.landing_url),
            toCsvCell(r.address),
            toCsvCell(r.rating),
            toCsvCell(r.platforms),
            toCsvCell(r.ad_status),
            toCsvCell(r.started_running_on),
            toCsvCell(r.library_id),
            toCsvCell(r.creative),
            toCsvCell(r.recommendation),
            toCsvCell(r.campaign_name),
            toCsvCell(fmtDate(r.created_at || r.scraped_at)),
            toCsvCell(r.dedup_key)
        ].join(','));
    }
    return out.join('\r\n');
}

// Export one campaign as CSV
app.get('/api/campaigns/:id/export/csv', (req, res) => {
    try {
        const leads = getLeadsData(req.params.id);
        const campaigns = getCampaignData();
        const campaign = campaigns.find(c => c.id === req.params.id);
        if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
        const csv = leadsToCsv(leads, campaign.name);
        const filename = `${campaign.name.replace(/[^a-zA-Z0-9]/g, '_')}_leads.csv`;
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send('﻿' + csv); // BOM so Excel opens UTF-8 correctly
    } catch (error) {
        console.error('CSV export failed:', error);
        res.status(500).json({ error: 'Failed to generate CSV' });
    }
});

// Export every lead from every campaign, deduplicated
app.get('/api/leads/export/csv', (req, res) => {
    try {
        const campaigns = getCampaignData();
        const seen = new Set();
        const merged = [];
        for (const c of campaigns) {
            const leads = getLeadsData(c.id);
            for (const l of leads) {
                const keys = LeadsRegistry.keysFor(l);
                if (!keys.length) continue;
                const primary = keys[0];
                if (seen.has(primary)) continue;
                seen.add(primary);
                merged.push({ ...l, _campaign: c.name });
            }
        }
        merged.sort((a, b) => (b.intelligence?.score || 0) - (a.intelligence?.score || 0));
        const csv = leadsToCsv(
            merged.map(l => ({ ...l, source: l.source || l._campaign })),
            'ALL'
        );
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="all_leads.csv"`);
        res.send('﻿' + csv);
    } catch (error) {
        console.error('All-leads CSV export failed:', error);
        res.status(500).json({ error: 'Failed to generate CSV' });
    }
});

// ─── Leads Database (SQLite) ────────────────────────────────
// Query all saved leads across every campaign.
// Filters: ?campaignId= &priority=HIGH &minScore=60 &source= &search= &hasContact=true &page= &limit=
app.get('/api/db/leads', async (req, res) => {
    try {
        const result = await leadsDb.getLeads(req.query);
        res.json(result);
    } catch (error) {
        console.error('DB leads query failed:', error);
        res.status(500).json({ error: 'Failed to query leads database' });
    }
});

// Database totals: lead count, contact coverage, priority breakdown
app.get('/api/db/stats', async (req, res) => {
    try {
        res.json(await leadsDb.getStats());
    } catch (error) {
        console.error('DB stats failed:', error);
        res.status(500).json({ error: 'Failed to load database stats' });
    }
});

// Export the entire database (respecting the same filters) as CSV
app.get('/api/db/leads/export/csv', async (req, res) => {
    try {
        // exportLeads applies the same filters (source, minScore, hasContact,
        // search) as the dashboard, so the CSV matches exactly what you see.
        const rows = await leadsDb.exportLeads(req.query);
        const csv = dbRowsToCsv(rows);
        const stamp = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="leads_${stamp}_${rows.length}.csv"`);
        res.send('﻿' + csv);
    } catch (error) {
        console.error('DB CSV export failed:', error);
        res.status(500).json({ error: 'Failed to export leads database' });
    }
});

// Manually re-import output/ folders into the database
app.post('/api/db/backfill', async (req, res) => {
    try {
        res.json({ success: true, ...(await leadsDb.backfillFromOutput()) });
    } catch (error) {
        console.error('DB backfill failed:', error);
        res.status(500).json({ error: 'Backfill failed' });
    }
});

// Registry stats — how many unique leads tracked
app.get('/api/leads/registry/stats', async (req, res) => {
    res.json(await leadsRegistry.stats());
});

// Registry reset (lets the user re-pull leads from scratch if needed)
app.post('/api/leads/registry/reset', async (req, res) => {
    await leadsRegistry.reset();
    res.json({ success: true, ...(await leadsRegistry.stats()) });
});

// ─── Outreach / Email Marketing ─────────────────────────────
// Whether real SMTP sending is available, or the UI should fall back to mailto.
app.get('/api/outreach/mode', (req, res) => {
    res.json({
        provider: mailer.providerName(),          // 'resend' | 'smtp' | 'manual'
        smtp: mailer.isSmtpConfigured(),
        from: mailer.fromAddress() || null
    });
});

// dedup_keys of leads already emailed — so the UI can badge them.
app.get('/api/outreach/sent', async (req, res) => {
    try {
        res.json({ keys: await leadsDb.getSentKeys() });
    } catch (e) {
        res.status(500).json({ error: 'Failed to load outreach status' });
    }
});

// Generate a personalized email draft for each selected lead.
app.post('/api/outreach/generate', async (req, res) => {
    try {
        const keys = Array.isArray(req.body.keys) ? req.body.keys.slice(0, 100) : [];
        if (!keys.length) return res.status(400).json({ error: 'No leads selected' });
        const industry = req.body.industry || process.env.PRIMARY_INDUSTRY || 'professional';
        const yourService = req.body.yourService ||
            'Marketing & systems for faith-based coaches — aliveandfreeconsulting.com';
        const style = req.body.style || 'balanced';
        const language = req.body.language || 'english';

        const rows = await leadsDb.getLeadsByKeys(keys);
        const marketingAI = new MarketingAI();
        const results = [];
        const toStore = [];
        for (const row of rows) {
            let lead = {};
            try { lead = JSON.parse(row.raw_json || '{}'); } catch { /* ignore */ }
            lead.name = row.name || lead.name;
            lead.email = row.email || lead.email;
            let subject = '', body = '', error = '';
            try {
                const content = await marketingAI.generateIndustrySpecificContent(
                    lead, industry, yourService, style, language
                );
                if (content) {
                    subject = content.subject || content.email_subject || content.emailSubject ||
                        `A quick idea for ${lead.name || 'you'}`;
                    body = content.email || content.email_body || content.emailBody || content.message || '';
                }
                if (!body) error = 'No content generated';
            } catch (e) {
                error = e.message;
            }
            results.push({ key: row.dedup_key, name: row.name, email: row.email, subject, body, error });
            toStore.push({
                key: row.dedup_key, to: row.email, subject, body,
                status: 'draft', error, generatedAt: new Date().toISOString()
            });
        }
        try { await leadsDb.recordOutreach(toStore); } catch (e) { /* non-fatal */ }
        res.json({ results });
    } catch (error) {
        console.error('Outreach generate failed:', error);
        res.status(500).json({ error: error.message || 'Failed to generate drafts' });
    }
});

// Send the given messages. SMTP if configured, else mode:'manual' (client mailto).
app.post('/api/outreach/send', async (req, res) => {
    try {
        const messages = Array.isArray(req.body.messages) ? req.body.messages.slice(0, 5000) : [];
        if (!messages.length) return res.status(400).json({ error: 'No messages' });

        // No server-side provider — client opens mailto: drafts instead.
        if (mailer.providerName() === 'manual') {
            return res.json({ mode: 'manual', messages });
        }

        // Enqueue for the background worker (handles large volume + rate limiting).
        const rows = messages
            .filter(m => m.to)
            .map(m => ({ key: m.key, to: m.to, subject: m.subject, body: m.body, provider: mailer.providerName() }));
        await leadsDb.enqueueOutreach(rows);
        broadcastSSE({ type: 'outreach_queued', queued: rows.length });
        res.json({ mode: 'queued', queued: rows.length, provider: mailer.providerName() });
    } catch (error) {
        console.error('Outreach send failed:', error);
        res.status(500).json({ error: error.message || 'Failed to send' });
    }
});

// Activity log — paginated; filter with ?status=sent|failed|queued|delivered|opened
app.get('/api/outreach/log', async (req, res) => {
    try {
        res.json(await leadsDb.getOutreachLog(req.query));
    } catch (e) {
        console.error('Outreach log failed:', e);
        res.status(500).json({ error: 'Failed to load outreach log' });
    }
});

// Status counts for the stats strip.
app.get('/api/outreach/stats', async (req, res) => {
    try {
        res.json(await leadsDb.getOutreachStats());
    } catch (e) {
        res.status(500).json({ error: 'Failed to load outreach stats' });
    }
});

// Resend a single message using its stored subject/body.
app.post('/api/outreach/resend', async (req, res) => {
    try {
        const key = req.body.key;
        if (!key) return res.status(400).json({ error: 'No key' });
        const row = await leadsDb.getOutreachByKey(key);
        if (!row || !row.to_email) return res.status(404).json({ error: 'No stored email for this lead' });
        if (mailer.providerName() === 'manual') {
            return res.json({ mode: 'manual', message: { key, to: row.to_email, subject: row.subject, body: row.body } });
        }
        await leadsDb.enqueueOutreach([{
            key, to: row.to_email, subject: row.subject, body: row.body, provider: mailer.providerName()
        }]);
        broadcastSSE({ type: 'outreach_queued', queued: 1 });
        res.json({ mode: 'queued', queued: 1 });
    } catch (e) {
        console.error('Outreach resend failed:', e);
        res.status(500).json({ error: e.message || 'Resend failed' });
    }
});

// Resend delivery webhook — updates delivered/opened/bounced by provider id.
// Point your Resend dashboard's Webhook at POST /api/outreach/webhook.
app.post('/api/outreach/webhook', async (req, res) => {
    try {
        const evt = req.body || {};
        const id = evt.data && (evt.data.email_id || evt.data.id);
        const map = {
            'email.delivered': 'delivered',
            'email.opened': 'opened',
            'email.bounced': 'bounced',
            'email.complained': 'complained'
        };
        const status = map[evt.type];
        if (id && status) {
            const row = await leadsDb.getOutreachByProviderId(id);
            if (row) {
                await leadsDb.updateOutreachStatus(row.dedup_key, { status });
                broadcastSSE({ type: 'outreach_status', key: row.dedup_key, status });
            }
        }
        res.json({ ok: true });
    } catch (e) {
        res.status(200).json({ ok: false }); // don't trigger webhook retries on our errors
    }
});

// Mark messages as sent — used after the client opens mailto drafts manually.
app.post('/api/outreach/mark', async (req, res) => {
    try {
        const items = Array.isArray(req.body.items) ? req.body.items : [];
        const toStore = items.map(m => ({
            key: m.key, to: m.to, subject: m.subject, body: m.body,
            status: m.status || 'sent', sentAt: new Date().toISOString()
        }));
        await leadsDb.recordOutreach(toStore);
        res.json({ success: true, marked: toStore.length });
    } catch (e) {
        res.status(500).json({ error: 'Failed to mark outreach' });
    }
});

// Create new campaign endpoint
app.post('/api/campaigns', async (req, res) => {
    try {
        const { name, industry, location, searchQuery, maxResults, yourService, contentStyle, language, source, country, adStatus, minScore } = req.body;

        // Only the search query is truly required for a scrape — everything else
        // has a sensible default so the form stays lean.
        if (!searchQuery) {
            return res.status(400).json({ error: 'A search query (keywords) is required' });
        }

        const campaignName = (name && name.trim()) || `${searchQuery} — ${country || 'US'}`;
        const campaignId = `campaign_${campaignName.replace(/\s+/g, '_')}_${Date.now()}`;

        // Store campaign in active campaigns
        activeCampaigns.set(campaignId, {
            id: campaignId,
            name: campaignName,
            industry: industry || process.env.PRIMARY_INDUSTRY || 'professional',
            location: location || country || 'US',
            searchQuery,
            maxResults: parseInt(maxResults) || 40,
            yourService: yourService || 'Marketing & systems for faith-based coaches — aliveandfreeconsulting.com',
            contentStyle: contentStyle || 'balanced',
            language: language || 'english',
            source: source || 'apify_ads',
            country: country || 'US',
            // Meta Ad Library: 'active' (currently spending) vs 'all'.
            adStatus: adStatus === 'all' ? 'all' : 'active',
            // Only keep leads scoring at/above this (0 = keep everything).
            minScore: parseInt(minScore) || 0,
            // Default: skip duplicates. The form posts 'on'/'true' when checked, omits when unchecked.
            // To explicitly disable from the API, pass skipDuplicates: false (or 'false').
            skipDuplicates: !(req.body.skipDuplicates === false || req.body.skipDuplicates === 'false' || req.body.skipDuplicates === 'off'),
            enrichContacts: (() => {
                const v = req.body.enrichContacts;
                if (v === true || v === 'true' || v === 'on') return true;
                if (v === false || v === 'false' || v === 'off') return false;
                return /^true$/i.test(process.env.ENRICH_CONTACTS_DEFAULT || '');
            })(),
            status: 'starting',
            progress: 0,
            startedAt: new Date().toISOString()
        });

        // Broadcast campaign start
        broadcastSSE({
            type: 'campaign_started',
            campaignId,
            message: `Campaign "${name}" started`
        });

        // Start campaign execution in background
        executeCampaignAsync(campaignId);

        res.json({ 
            success: true, 
            campaignId,
            message: 'Campaign started successfully'
        });

    } catch (error) {
        console.error('Error creating campaign:', error);
        res.status(500).json({ error: 'Failed to create campaign' });
    }
});

// Get active campaign status
app.get('/api/campaigns/:id/status', (req, res) => {
    const campaign = activeCampaigns.get(req.params.id);
    if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
    }
    res.json(campaign);
});

function getExcludePatterns() {
    const raw = process.env.EXCLUDE_PAGES || '';
    return raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function applyExcludeFilter(leads) {
    const patterns = getExcludePatterns();
    if (!patterns.length) return { kept: leads, removed: [] };
    const removed = [];
    const kept = leads.filter(lead => {
        const hay = `${lead.name || ''} ${lead.website || ''} ${lead.pageUrl || ''}`.toLowerCase();
        const hit = patterns.some(p => hay.includes(p));
        if (hit) removed.push(lead);
        return !hit;
    });
    return { kept, removed };
}

function sourceLabel(source) {
    return {
        meta_ads: 'Meta Ad Library',
        meta_pages: 'Facebook Pages',
        meta_combined: 'Meta (Ads + Pages)',
        google_maps: 'Google Maps',
        ...apifySources.labels()
    }[source] || source;
}

// Decide which enrichment engine to use for a campaign.
//   ENRICH_PROVIDER=apify  -> always Apify (falls back to HTTP if no token)
//   ENRICH_PROVIDER=http   -> always the built-in cheerio enricher
//   ENRICH_PROVIDER=auto   -> Apify for FB/IG sources when a token is present
function chooseEnrichProvider(source) {
    const pref = (process.env.ENRICH_PROVIDER || 'auto').toLowerCase();
    if (pref === 'http') return 'http';
    if (pref === 'apify') return apifySources.isConfigured() ? 'apify' : 'http';
    const apifyFriendly = apifySources.isApifySource(source) || /meta|instagram/i.test(source);
    return apifyFriendly && apifySources.isConfigured() ? 'apify' : 'http';
}

// Async campaign execution function
async function executeCampaignAsync(campaignId) {
    const campaign = activeCampaigns.get(campaignId);
    if (!campaign) return;

    let scraper = null;
    try {
        const source = campaign.source || 'meta_ads';
        const marketingAI = new MarketingAI();
        const intelligence = new LeadIntelligence();

        // Update progress: Starting
        campaign.status = 'scraping';
        campaign.progress = 10;
        broadcastSSE({
            type: 'campaign_progress',
            campaignId,
            progress: 10,
            message: `Starting lead discovery from ${sourceLabel(source)}...`
        });

        // Phase 1: Lead Discovery — routed by source
        let rawLeads = [];
        if (apifySources.isApifySource(source)) {
            if (!apifySources.isConfigured()) {
                throw new Error('APIFY_TOKEN is not set — add it to your environment to use Apify sources.');
            }
            const src = apifySources.getSource(source);
            rawLeads = await src.scrape({
                query: campaign.searchQuery,
                maxResults: campaign.maxResults,
                country: campaign.country || 'US',
                location: campaign.location,
                industry: campaign.industry,
                activeStatus: campaign.adStatus || 'active'
            });
        } else if (source === 'meta_ads') {
            scraper = new MetaScraper();
            rawLeads = await scraper.scrapeAdLibrary(campaign.searchQuery, campaign.maxResults, campaign.country || 'US');
        } else if (source === 'meta_pages') {
            scraper = new MetaScraper();
            rawLeads = await scraper.scrapePagesSearch(campaign.searchQuery, campaign.maxResults);
        } else if (source === 'meta_combined') {
            scraper = new MetaScraper();
            const half = Math.max(5, Math.floor(campaign.maxResults / 2));
            const ads = await scraper.scrapeAdLibrary(campaign.searchQuery, half, campaign.country || 'US');
            const pages = await scraper.scrapePagesSearch(campaign.searchQuery, half);
            // Dedupe by pageUrl/name
            const seen = new Set();
            rawLeads = [...ads, ...pages].filter(l => {
                const key = (l.website || l.name || '').toLowerCase();
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
        } else {
            // google_maps fallback
            scraper = new BusinessScraper();
            rawLeads = await scraper.scrapeGoogleMaps(campaign.searchQuery, campaign.maxResults);
        }

        // Drop excluded pages (own brand, partners, etc.)
        const excludeResult = applyExcludeFilter(rawLeads);
        rawLeads = excludeResult.kept;
        campaign.excludedCount = excludeResult.removed.length;
        if (campaign.excludedCount > 0) {
            console.log(`[Campaign ${campaignId}] Excluded ${campaign.excludedCount} leads matching EXCLUDE_PAGES`);
        }

        // Dedupe against the global lead registry (skip leads we've seen before)
        let skippedDuplicates = 0;
        if (campaign.skipDuplicates !== false) {
            const filtered = await leadsRegistry.filterNew(rawLeads);
            skippedDuplicates = filtered.skipped.length;
            rawLeads = filtered.fresh;
            if (skippedDuplicates > 0) {
                broadcastSSE({
                    type: 'campaign_progress',
                    campaignId,
                    progress: 30,
                    message: `Skipped ${skippedDuplicates} duplicates from prior runs`
                });
            }
        }
        campaign.skippedDuplicates = skippedDuplicates;
        
        campaign.progress = 40;
        broadcastSSE({
            type: 'campaign_progress',
            campaignId,
            progress: 40,
            message: `Found ${rawLeads.length} raw leads`
        });

        // Optional Phase 1.5: Contact Enrichment
        if (campaign.enrichContacts && rawLeads.length > 0) {
            campaign.status = 'enriching';
            broadcastSSE({
                type: 'campaign_progress',
                campaignId,
                progress: 45,
                message: `Enriching ${rawLeads.length} leads with contact info...`
            });
            const provider = chooseEnrichProvider(source);
            try {
                if (provider === 'apify') {
                    rawLeads = await apifyEnrichLeads(rawLeads, { deepEnrich: true });
                } else {
                    rawLeads = await enrichLeads(rawLeads, { concurrency: 4, maxUrlsPerLead: 4 });
                }
            } catch (e) {
                console.warn(`[Enricher:${provider}] failed:`, e.message);
            }
        }

        // Phase 2: Lead Intelligence
        campaign.status = 'analyzing';
        const scoredLeads = await intelligence.scoreLeads(rawLeads, campaign.industry);

        // Quality floor: only KEEP leads at/above minScore (0 = keep all). We
        // still record every scraped lead in the registry below so we don't
        // re-pay to scrape the dropped ones next run.
        const minScore = campaign.minScore || 0;
        const keptLeads = minScore > 0
            ? scoredLeads.filter(l => (l.intelligence?.score || 0) >= minScore)
            : scoredLeads;
        campaign.droppedByScore = scoredLeads.length - keptLeads.length;

        campaign.progress = 70;
        broadcastSSE({
            type: 'campaign_progress',
            campaignId,
            progress: 70,
            message: minScore > 0
                ? `Kept ${keptLeads.length} leads scoring ≥ ${minScore} (dropped ${campaign.droppedByScore})`
                : 'Analyzing lead intelligence...'
        });

        // Phase 3: Content Generation (for high-priority leads only)
        campaign.status = 'generating';
        const highPriorityLeads = keptLeads.filter(lead => lead.intelligence.priority === 'HIGH');
        
        for (let i = 0; i < Math.min(highPriorityLeads.length, 5); i++) {
            try {
                const content = await marketingAI.generateIndustrySpecificContent(
                    highPriorityLeads[i],
                    campaign.industry,
                    campaign.yourService,
                    campaign.contentStyle,
                    campaign.language
                );
                
                // Store the generated content in the lead
                if (content) {
                    highPriorityLeads[i].intelligence.marketingContent = content;
                }
            } catch (error) {
                console.log(`Failed to generate content for lead ${i + 1}:`, error.message);
            }
        }

        campaign.progress = 90;
        broadcastSSE({
            type: 'campaign_progress',
            campaignId,
            progress: 90,
            message: 'Generating marketing content...'
        });

        // Phase 4: Save Results
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const outputDir = path.join(__dirname, '../../output', campaignId);
        const rootOutputDir = path.join(__dirname, '../../output');
        
        if (!fs.existsSync(rootOutputDir)) {
            fs.mkdirSync(rootOutputDir);
        }
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Save campaign results (only the kept leads — those that passed the
        // quality floor).
        const campaignInfo = {
            ...campaign,
            executedAt: new Date().toISOString(),
            results: {
                totalLeads: keptLeads.length,
                highQualityLeads: keptLeads.filter(lead => lead.intelligence.score >= 65).length,
                priorityLeads: keptLeads.filter(lead => lead.intelligence.priority === 'HIGH').length,
                averageScore: keptLeads.length ? Math.round(keptLeads.reduce((sum, lead) => sum + lead.intelligence.score, 0) / keptLeads.length) : 0,
                contentGenerated: Math.min(highPriorityLeads.length, 5),
                droppedByScore: campaign.droppedByScore || 0,
                enhancedAI: true
            },
            outputPath: outputDir
        };

        fs.writeFileSync(`${outputDir}/campaign_info.json`, JSON.stringify(campaignInfo, null, 2));
        fs.writeFileSync(`${outputDir}/leads_with_intelligence.json`, JSON.stringify(keptLeads, null, 2));

        // Register EVERY scraped lead so subsequent runs skip them (even the
        // ones dropped by the score floor — we already paid to scrape them).
        const recordedCount = await leadsRegistry.recordMany(scoredLeads, campaignId);
        campaign.recordedToRegistry = recordedCount;

        // Persist campaign + the kept leads to the database
        try {
            await leadsDb.saveCampaign(campaignInfo);
            const dbResult = await leadsDb.saveLeads(keptLeads, campaignId, campaign.name);
            campaign.savedToDb = dbResult;
            console.log(`[LeadsDb] Campaign ${campaignId}: ${dbResult.added} new leads saved, ${dbResult.updated} updated`);
        } catch (dbErr) {
            console.warn('[LeadsDb] Save failed:', dbErr.message);
        }

        // Complete campaign
        campaign.status = 'completed';
        campaign.progress = 100;
        campaign.completedAt = new Date().toISOString();
        campaign.results = campaignInfo.results;

        broadcastSSE({
            type: 'campaign_completed',
            campaignId,
            progress: 100,
            message: `Campaign completed! ${keptLeads.length} leads saved`,
            results: campaignInfo.results
        });

        // Clean up
        if (scraper && typeof scraper.close === 'function') {
            try { await scraper.close(); } catch (e) { /* ignore */ }
        }

        // Remove from active campaigns after 5 minutes
        setTimeout(() => {
            activeCampaigns.delete(campaignId);
        }, 5 * 60 * 1000);

    } catch (error) {
        console.error(`Campaign ${campaignId} failed:`, error);

        campaign.status = 'failed';
        campaign.error = error.message;

        if (scraper && typeof scraper.close === 'function') {
            try { await scraper.close(); } catch (e) { /* ignore */ }
        }

        broadcastSSE({
            type: 'campaign_failed',
            campaignId,
            message: `Campaign failed: ${error.message}`
        });
    }
}

// Health check endpoint
app.get('/api/health', (req, res) => {
    const { isConfigured, getModel } = require('../openaiClient');
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        timestamp: new Date().toISOString(),
        openai: {
            configured: isConfigured(),
            model: getModel(),
            baseUrl: process.env.OPENAI_BASE_URL || 'default'
        },
        activeCampaigns: activeCampaigns.size,
        sseConnections: sseConnections.size
    });
});

// Serve main dashboard
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`🚀 Business Leads AI Web Dashboard running on http://localhost:${PORT}`);
    console.log(`📊 Dashboard: http://localhost:${PORT}`);
    console.log(`🔌 API: http://localhost:${PORT}/api`);
    console.log(`❤️  Health: http://localhost:${PORT}/api/health`);
});

// Graceful shutdown
function gracefulShutdown(signal) {
    console.log(`\n⏹️  ${signal} received. Shutting down gracefully...`);
    
    // Close SSE connections
    sseConnections.forEach(res => {
        try { res.end(); } catch (e) { /* ignore */ }
    });
    sseConnections.clear();

    server.close(() => {
        console.log('✅ Server closed');
        process.exit(0);
    });

    // Force shutdown after 10 seconds
    setTimeout(() => {
        console.error('❌ Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

module.exports = app;