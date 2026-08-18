// ═══════════════════════════════════════════════════════════
// Main Dashboard Application
// ═══════════════════════════════════════════════════════════

class Dashboard {
    constructor() {
        this.currentSection = 'leads';
        this.campaigns = [];
        this.allLeads = [];
        this.filteredLeads = [];
        this.leadsTable = null;
        this.progressManager = null;
        this.eventSource = null;

        // Email Marketing / outreach state
        this.outreachLeads = [];
        this.outreachSelected = new Set();
        this.outreachDrafts = {};          // dedup_key -> { name, email, subject, body }
        this.outreachSentKeys = new Set();
        this.outreachMode = { provider: 'manual', from: null };
        this.outreachView = 'compose';
        this._outreachLogStatus = '';

        this.init();
    }

    async init() {
        this.initTheme();
        this.checkAuth();
        this.setupEventListeners();
        this.setupMobileNav();
        this.setupRealTimeUpdates();
        this.progressManager = new ProgressManager('campaignProgressModal');

        await this.loadAllLeads();
    }

    // ─── Auth ───────────────────────────────────────────────
    async checkAuth() {
        try {
            const s = await api.request('/auth/status');
            const btn = document.getElementById('signOutBtn');
            if (btn) btn.style.display = s.enabled ? '' : 'none';
        } catch (e) { /* non-fatal */ }
    }

    async logout() {
        try { await api.request('/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
        window.location.href = '/login';
    }

    // ─── Theme Management ───────────────────────────────────
    initTheme() {
        const saved = localStorage.getItem('theme');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const theme = saved || (prefersDark ? 'dark' : 'light');
        this.setTheme(theme);

        const toggle = document.getElementById('themeToggle');
        if (toggle) {
            toggle.addEventListener('click', () => {
                const current = document.documentElement.getAttribute('data-theme');
                this.setTheme(current === 'light' ? 'dark' : 'light');
            });
        }
    }

    setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('theme', theme);

        // Update theme-color meta
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
            meta.content = theme === 'dark' ? '#0c0c0c' : '#f6f5f0';
        }

        // Toggle sun/moon icons
        const moon = document.querySelector('.icon-moon');
        const sun = document.querySelector('.icon-sun');
        if (moon && sun) {
            if (theme === 'light') {
                moon.style.display = 'none';
                sun.style.display = 'block';
            } else {
                moon.style.display = 'block';
                sun.style.display = 'none';
            }
        }
    }

    // ─── Mobile Navigation ──────────────────────────────────
    setupMobileNav() {
        const hamburger = document.getElementById('hamburgerBtn');
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');

        if (hamburger) {
            hamburger.addEventListener('click', () => {
                sidebar.classList.toggle('open');
                overlay.classList.toggle('active');
            });
        }

        if (overlay) {
            overlay.addEventListener('click', () => {
                sidebar.classList.remove('open');
                overlay.classList.remove('active');
            });
        }

        // Bottom nav items
        document.querySelectorAll('.bottom-nav-item').forEach(item => {
            item.addEventListener('click', () => {
                const section = item.dataset.section;
                if (section) this.showSection(section);
            });
        });
    }

    closeMobileMenu() {
        const sidebar = document.getElementById('sidebar');
        const overlay = document.getElementById('sidebarOverlay');
        if (sidebar) sidebar.classList.remove('open');
        if (overlay) overlay.classList.remove('active');
    }

    // ─── Event Listeners ────────────────────────────────────
    setupEventListeners() {
        document.querySelectorAll('.sidebar .nav-item[data-section]').forEach(item => {
            item.addEventListener('click', () => {
                const section = item.dataset.section;
                if (section) this.showSection(section);
            });
        });

        const search = document.getElementById('leadsSearch');
        if (search) {
            search.addEventListener('input', e => this.filterLeads(e.target.value));
        }

        const searchFilter = document.getElementById('leadsSearchFilter');
        if (searchFilter) {
            searchFilter.addEventListener('change', e => this.filterBySearch(e.target.value));
        }

        document.querySelectorAll('.score-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.score-pill').forEach(b => b.classList.toggle('active', b === btn));
                this.filterByMinScore(btn.dataset.min);
            });
        });

        const outreachSearch = document.getElementById('outreachSearch');
        if (outreachSearch) {
            outreachSearch.addEventListener('input', () => this.renderOutreachTable());
        }

        document.querySelectorAll('.outreach-log-filter').forEach(btn => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('.outreach-log-filter').forEach(b => b.classList.toggle('active', b === btn));
                this._outreachLogStatus = btn.dataset.status || '';
                this.loadOutreachLog();
            });
        });
    }

    // ─── Section Navigation (kept for nav highlight) ───────
    showSection(sectionName) {
        this.currentSection = sectionName;

        document.querySelectorAll('.sidebar .nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.section === sectionName);
        });
        document.querySelectorAll('.bottom-nav-item').forEach(item => {
            item.classList.toggle('active', item.dataset.section === sectionName);
        });
        document.querySelectorAll('.section').forEach(section => {
            section.classList.toggle('active', section.id === `section-${sectionName}`);
        });

        this.closeMobileMenu();

        if (sectionName === 'leads') this.loadAllLeads();
        if (sectionName === 'outreach') this.loadOutreach();
    }

    // ─── Real-Time Updates (SSE) ────────────────────────────
    setupRealTimeUpdates() {
        try {
            this.eventSource = new EventSource('/api/events');

            this.eventSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    this.handleSSEEvent(data);
                } catch (e) { /* ignore parse errors */ }
            };

            this.eventSource.onerror = () => {
                setTimeout(() => this.setupRealTimeUpdates(), 5000);
            };
        } catch (e) {
            console.log('SSE not available');
        }
    }

    handleSSEEvent(data) {
        switch (data.type) {
            case 'campaign_started':
                showNotification('Search started', data.message, 'info');
                break;
            case 'campaign_progress':
                if (this.progressManager) {
                    this.progressManager.updateProgress(data.progress, data.message);
                }
                break;
            case 'campaign_completed':
                showNotification('Leads ready', data.message, 'success');
                if (this.progressManager) {
                    this.progressManager.complete(data.results);
                }
                this.loadAllLeads();
                break;
            case 'campaign_failed':
                showNotification('Search failed', data.message, 'error');
                if (this.progressManager) {
                    this.progressManager.error(data.message);
                }
                break;
            case 'outreach_queued':
            case 'outreach_progress':
            case 'outreach_status':
                // Refresh the activity view live while emails send in the background
                if (this.currentSection === 'outreach' && this.outreachView === 'activity') {
                    this.loadOutreachStats();
                    this.loadOutreachLog();
                }
                break;
        }
    }

    // ═══════════════════════════════════════════════════════
    // DATA LOADING — leads-only, aggregated across all searches
    // ═══════════════════════════════════════════════════════

    async loadAllLeads() {
        try {
            // Read the deduplicated master list straight from the database, so
            // every scraped lead shows here (incl. batch/volume runs) — not just
            // whatever campaign files happen to be on disk.
            const limitEl = document.getElementById('leadsLimit');
            const limit = (limitEl && limitEl.value) || '250';
            const p = new URLSearchParams({ limit });
            if (this._filterState.dateFrom) p.set('dateFrom', this._filterState.dateFrom);
            if (this._filterState.dateTo) p.set('dateTo', this._filterState.dateTo);
            const [data, stats] = await Promise.all([
                api.request(`/db/leads?${p.toString()}`),
                api.request(`/db/stats?${p.toString()}`).catch(() => null)
            ]);

            this.allLeads = (data.leads || []).map(r => ({
                name: r.name || '(no name)',
                email: r.email || '',
                phone: r.phone || '',
                website: r.website || r.landing_url || r.page_url || '',
                source: r.source || '',
                dateAdded: r.created_at || r.scraped_at || '',
                intelligence: { score: r.score, priority: (r.priority || '').toUpperCase() },
                dedup_key: r.dedup_key
            }));
            this.dbStats = stats;
            this.filteredLeads = this.allLeads;

            this.renderLeadStats();
            this.populateSourceFilter();
            this._applyFilters();

            const badge = document.getElementById('leadCount');
            if (badge) badge.textContent = api.formatNumber(stats ? stats.totalLeads : this.allLeads.length);

            // Per-campaign vCard export no longer applies to the master list.
            const vcardBtn = document.getElementById('exportVCardBtn');
            if (vcardBtn) vcardBtn.style.display = 'none';
            const csvBtn = document.getElementById('exportCsvBtn');
            if (csvBtn) csvBtn.style.display = this.allLeads.length ? '' : 'none';

            this.loadRegistryStrip();
        } catch (error) {
            api.handleError(error, 'loading leads');
            const container = document.getElementById('leadsTableContainer');
            if (container) {
                container.innerHTML = '<div class="card" style="text-align:center;padding:2rem"><p class="empty-title">Failed to load leads</p></div>';
            }
        }
    }

    // Filter state — search text + source + min score + date range
    _filterState = { query: '', searchId: '', minScore: 0, dateFrom: '', dateTo: '' };

    _ymd(d) { return d.toISOString().slice(0, 10); }

    onDatePreset(v) {
        const custom = document.getElementById('leadsCustomDates');
        if (v === 'custom') { if (custom) custom.style.display = 'inline-flex'; return; }
        if (custom) custom.style.display = 'none';
        if (!v) {
            this._filterState.dateFrom = ''; this._filterState.dateTo = '';
        } else if (v === 'today') {
            const t = this._ymd(new Date());
            this._filterState.dateFrom = t; this._filterState.dateTo = t;
        } else {
            const to = new Date();
            const from = new Date();
            from.setUTCDate(from.getUTCDate() - (Number(v) - 1));
            this._filterState.dateFrom = this._ymd(from);
            this._filterState.dateTo = this._ymd(to);
        }
        this.loadAllLeads();
    }

    onCustomDate() {
        const f = document.getElementById('leadsDateFrom');
        const t = document.getElementById('leadsDateTo');
        this._filterState.dateFrom = (f && f.value) || '';
        this._filterState.dateTo = (t && t.value) || '';
        this.loadAllLeads();
    }

    filterLeads(query) {
        this._filterState.query = (query || '').trim().toLowerCase();
        this._applyFilters();
    }

    filterBySearch(searchId) {
        this._filterState.searchId = searchId || '';
        this._applyFilters();
    }

    filterByMinScore(minScore) {
        this._filterState.minScore = Number(minScore) || 0;
        this._applyFilters();
    }

    _applyFilters() {
        const { query, searchId, minScore } = this._filterState; // searchId = source
        this.filteredLeads = this.allLeads.filter(l => {
            if (searchId && l.source !== searchId) return false;
            if (minScore > 0 && Number(l.intelligence?.score || 0) < minScore) return false;
            if (this._onlyEmail && !l.email) return false;
            if (query) {
                const hay = [l.name, l.email, l.phone, l.website, l.source]
                    .filter(Boolean).join(' ').toLowerCase();
                if (!hay.includes(query)) return false;
            }
            return true;
        });
        this.renderLeadsTable(this.filteredLeads);
        const strip = document.getElementById('leadCountStrip');
        if (strip) {
            strip.textContent = `${this.filteredLeads.length} shown`;
        }
    }

    setOnlyEmail(on) {
        this._onlyEmail = !!on;
        this._applyFilters();
    }

    populateSourceFilter() {
        const select = document.getElementById('leadsSearchFilter');
        if (!select) return;
        const current = select.value;
        const sources = [...new Set(this.allLeads.map(l => l.source).filter(Boolean))].sort();
        const opts = ['<option value="">All sources</option>']
            .concat(sources.map(s => `<option value="${this._escapeHtml(s)}">${this._escapeHtml(s)}</option>`));
        select.innerHTML = opts.join('');
        if (current && sources.includes(current)) select.value = current;
    }

    _escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    }

    // ═══════════════════════════════════════════════════════
    // RENDERING — leads only
    // ═══════════════════════════════════════════════════════

    renderLeadStats() {
        const grid = document.getElementById('leadStatsGrid');
        if (!grid) return;

        const s = this.dbStats;
        const total = s ? s.totalLeads : this.allLeads.length;
        const withEmail = s ? s.withEmail : this.allLeads.filter(l => l.email).length;
        const withPhone = s ? s.withPhone : this.allLeads.filter(l => l.phone).length;
        const scores = this.allLeads.map(l => Number(l.intelligence?.score)).filter(n => !isNaN(n));
        const avgScore = s ? s.averageScore : (scores.length ? Math.round(scores.reduce((a,b) => a+b, 0) / scores.length) : 0);

        grid.innerHTML = `
            <div class="stat-card">
                <div class="stat-header">
                    <span class="stat-label">Total Leads</span>
                    <div class="stat-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
                    </div>
                </div>
                <div class="stat-value">${api.formatNumber(total)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-header">
                    <span class="stat-label">With Email</span>
                    <div class="stat-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                    </div>
                </div>
                <div class="stat-value">${api.formatNumber(withEmail)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-header">
                    <span class="stat-label">With Phone</span>
                    <div class="stat-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                    </div>
                </div>
                <div class="stat-value">${api.formatNumber(withPhone)}</div>
            </div>
            <div class="stat-card">
                <div class="stat-header">
                    <span class="stat-label">Avg Score</span>
                    <div class="stat-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
                    </div>
                </div>
                <div class="stat-value">${avgScore}</div>
            </div>
        `;
    }

    renderLeadsTable(leads) {
        const container = document.getElementById('leadsTableContainer');
        if (!container) return;

        if (!leads || leads.length === 0) {
            container.innerHTML = `
                <div class="card" style="text-align:center; padding:3rem">
                    <p class="empty-title">No leads yet</p>
                    <p class="empty-message">Click <strong>Find New Leads</strong> to start a search.</p>
                </div>
            `;
            return;
        }

        this.leadsTable = new DataTable(container, {
            columns: [
                { key: 'name', title: 'Business', type: 'text' },
                { key: 'email', title: 'Email', type: 'text' },
                { key: 'phone', title: 'Phone', type: 'text' },
                { key: 'website', title: 'Website', type: 'link' },
                { key: 'source', title: 'Source', type: 'text' },
                { key: 'intelligence.score', title: 'Score', type: 'score' },
                { key: 'intelligence.priority', title: 'Priority', type: 'priority' },
                { key: 'dateAdded', title: 'Date Added', type: 'date' }
            ],
            data: leads,
            pagination: true,
            pageSize: 25,
            sortable: true
        });

        this.leadsTable.render();
    }

    // ═══════════════════════════════════════════════════════
    // FIND-LEADS ACTION
    // ═══════════════════════════════════════════════════════

    async createCampaign(event) {
        event.preventDefault();

        const form = document.getElementById('newCampaignForm');
        const formData = new FormData(form);
        const campaignData = Object.fromEntries(formData.entries());
        // Checkboxes are omitted from FormData when unchecked — set explicitly.
        const skipBox = document.getElementById('campaignSkipDuplicates');
        campaignData.skipDuplicates = skipBox && skipBox.checked ? 'true' : 'false';
        const enrichBox = document.getElementById('campaignEnrichContacts');
        campaignData.enrichContacts = enrichBox && enrichBox.checked ? 'true' : 'false';
        campaignData.language = 'english';

        // Only the keywords are required now — everything else has a default.
        if (!campaignData.searchQuery) {
            showNotification('Missing keywords', 'Enter what to search for (e.g. "christian life coach").', 'warning');
            return;
        }
        const label = (campaignData.name && campaignData.name.trim()) || campaignData.searchQuery;

        try {
            hideModal();
            this.progressManager.show(label);

            const result = await api.createCampaign(campaignData);

            if (result.success) {
                showNotification('Search started', `Scraping leads for "${label}"`, 'success');
                form.reset();
            }
        } catch (error) {
            api.handleError(error, 'starting lead search');
            if (this.progressManager) {
                this.progressManager.error(error.message);
            }
        }
    }

    // ─── Marketing Content ──────────────────────────────────
    showMarketingContent(content, leadName) {
        const container = document.getElementById('marketingContent');
        
        const subject = content.subject || content.email_subject || '';
        const email = content.email || content.email_body || '';
        const whatsapp = content.whatsapp || content.whatsapp_message || '';

        container.innerHTML = `
            <h4 style="margin-bottom:var(--space-md);font-size:0.9rem;font-weight:600">Content for ${api.safeString(leadName)}</h4>
            ${subject ? `
                <div class="marketing-content" style="margin-bottom:var(--space-md)">
                    <div class="marketing-header"><h4>Email Subject</h4></div>
                    <div class="marketing-body"><div class="content-preview">${api.safeString(subject)}</div></div>
                </div>
            ` : ''}
            ${email ? `
                <div class="marketing-content" style="margin-bottom:var(--space-md)">
                    <div class="marketing-header"><h4>Email Body</h4></div>
                    <div class="marketing-body"><div class="content-preview">${api.safeString(email)}</div></div>
                    <div class="marketing-actions">
                        <button class="btn btn-secondary btn-sm" onclick="dashboard.sendEmail('${api.safeString(subject).replace(/'/g, "\\'")}', '${api.safeString(email).replace(/'/g, "\\'")}')">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/></svg>
                            Open Email
                        </button>
                    </div>
                </div>
            ` : ''}
            ${whatsapp ? `
                <div class="marketing-content" style="margin-bottom:var(--space-md)">
                    <div class="marketing-header"><h4>WhatsApp Message</h4></div>
                    <div class="marketing-body"><div class="content-preview">${api.safeString(whatsapp)}</div></div>
                    <div class="marketing-actions">
                        <button class="btn btn-success btn-sm" onclick="navigator.clipboard.writeText(${JSON.stringify(whatsapp).replace(/"/g, '&quot;')}).then(()=>showNotification('Copied','Message copied to clipboard','success'))">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                            Copy
                        </button>
                    </div>
                </div>
            ` : ''}
        `;

        showModal('marketingModal');
    }

    // ─── WhatsApp & Email ───────────────────────────────────
    openWhatsApp(phone, message) {
        try {
            let cleanPhone = phone.replace(/[^0-9+]/g, '');
            if (cleanPhone.startsWith('0')) {
                cleanPhone = '62' + cleanPhone.substring(1);
            }
            const text = encodeURIComponent(message || '');
            const url = `https://wa.me/${cleanPhone}${text ? '?text=' + text : ''}`;
            window.open(url, '_blank');
            showNotification('WhatsApp', 'Opening WhatsApp...', 'success');
        } catch (error) {
            api.handleError(error, 'opening WhatsApp');
        }
    }

    sendEmail(subject, body) {
        try {
            const mailtoUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
            window.open(mailtoUrl);
            showNotification('Email', 'Opening email client...', 'success');
        } catch (error) {
            api.handleError(error, 'opening email');
        }
    }

    // ─── Export ─────────────────────────────────────────────
    async exportAllVCards() {
        if (!this.campaigns || this.campaigns.length === 0) {
            showNotification('Export', 'No leads to export yet', 'warning');
            return;
        }
        try {
            this.campaigns.forEach((c, i) => {
                setTimeout(() => {
                    window.open(`/api/campaigns/${c.id}/export/vcard`, '_blank');
                }, i * 400);
            });
            showNotification('Export', `Downloading ${this.campaigns.length} vCard bundle${this.campaigns.length > 1 ? 's' : ''}...`, 'success');
        } catch (error) {
            api.handleError(error, 'exporting vCards');
        }
    }

    // Export dialog — pick the date range (and email-only) before downloading.
    openExportModal() {
        const preset = document.getElementById('exportDatePreset');
        if (preset) preset.value = '';
        const custom = document.getElementById('exportCustomRow');
        if (custom) custom.style.display = 'none';
        const oe = document.getElementById('exportOnlyEmail');
        if (oe) oe.checked = !!this._onlyEmail; // carry over the table's toggle as default
        const f = document.getElementById('exportDateFrom'); if (f) f.value = '';
        const t = document.getElementById('exportDateTo'); if (t) t.value = '';
        showModal('exportModal');
        this.updateExportCount();
    }

    onExportPreset(v) {
        const custom = document.getElementById('exportCustomRow');
        if (custom) custom.style.display = v === 'custom' ? '' : 'none';
        this.updateExportCount();
    }

    _exportParams() {
        const p = new URLSearchParams();
        const preset = (document.getElementById('exportDatePreset') || {}).value || '';
        let from = '', to = '';
        if (preset === 'today') {
            from = to = this._ymd(new Date());
        } else if (preset === '7' || preset === '30') {
            const toD = new Date(), fromD = new Date();
            fromD.setUTCDate(fromD.getUTCDate() - (Number(preset) - 1));
            from = this._ymd(fromD); to = this._ymd(toD);
        } else if (preset === 'custom') {
            from = (document.getElementById('exportDateFrom') || {}).value || '';
            to = (document.getElementById('exportDateTo') || {}).value || '';
        }
        if (from) p.set('dateFrom', from);
        if (to) p.set('dateTo', to);
        if ((document.getElementById('exportOnlyEmail') || {}).checked) p.set('hasEmail', 'true');
        // Carry the active source filter from the table, if any.
        const src = (this._filterState && this._filterState.searchId) || '';
        if (src) p.set('source', src);
        return p;
    }

    async updateExportCount() {
        const el = document.getElementById('exportCount');
        if (!el) return;
        const preset = (document.getElementById('exportDatePreset') || {}).value;
        if (preset === 'custom') {
            const f = (document.getElementById('exportDateFrom') || {}).value;
            const t = (document.getElementById('exportDateTo') || {}).value;
            if (!f || !t) { el.textContent = 'Pick a “from” and “to” date.'; return; }
        }
        el.textContent = 'Counting…';
        try {
            const p = this._exportParams();
            const s = await api.request('/db/stats?' + p.toString());
            const emailNote = p.get('hasEmail') ? '' : ` · ${api.formatNumber(s.withEmail)} with email`;
            el.textContent = `${api.formatNumber(s.totalLeads)} leads will download${emailNote}.`;
        } catch (e) { el.textContent = ''; }
    }

    doExport() {
        const preset = (document.getElementById('exportDatePreset') || {}).value;
        if (preset === 'custom') {
            const f = (document.getElementById('exportDateFrom') || {}).value;
            const t = (document.getElementById('exportDateTo') || {}).value;
            if (!f || !t) { showNotification('Pick dates', 'Choose a “from” and “to” date, or use a preset.', 'warning'); return; }
        }
        const p = this._exportParams();
        const qs = p.toString();
        window.open(`/api/db/leads/export/csv${qs ? '?' + qs : ''}`, '_blank');
        hideModal();
        showNotification('Export', 'Downloading your CSV…', 'success');
    }

    // ─── Registry stats strip ───────────────────────────────
    async loadRegistryStrip() {
        try {
            const stats = await api.request('/leads/registry/stats');
            const el = document.getElementById('registryStripText');
            const resetBtn = document.getElementById('registryResetBtn');
            if (el) {
                if (stats.uniqueLeads > 0) {
                    el.textContent = `${stats.uniqueLeads} unique lead${stats.uniqueLeads === 1 ? '' : 's'} tracked — future runs will skip these automatically.`;
                    if (resetBtn) resetBtn.style.display = 'inline-block';
                } else {
                    el.textContent = 'No leads tracked yet — your next search will populate the dedup index.';
                    if (resetBtn) resetBtn.style.display = 'none';
                }
            }
        } catch (e) { /* non-fatal */ }
    }

    async resetRegistry() {
        if (!confirm('Reset the dedup index? This forgets every lead you\'ve already pulled — future scrapes may return them again.')) return;
        try {
            await api.request('/leads/registry/reset', { method: 'POST' });
            showNotification('Registry', 'Dedup index cleared.', 'success');
            this.loadRegistryStrip();
        } catch (e) {
            api.handleError(e, 'resetting registry');
        }
    }

    // ═══════════════════════════════════════════════════════
    // EMAIL MARKETING / OUTREACH
    // ═══════════════════════════════════════════════════════

    async loadOutreach() {
        const container = document.getElementById('outreachTableContainer');
        if (container) container.innerHTML = '<div class="card" style="text-align:center;padding:2rem"><p class="empty-title">Loading…</p></div>';

        // Send mode + already-contacted, in parallel with the leads pull
        try {
            const [mode, sent] = await Promise.all([
                api.request('/outreach/mode').catch(() => ({ smtp: false })),
                api.request('/outreach/sent').catch(() => ({ keys: [] }))
            ]);
            this.outreachMode = mode || { smtp: false };
            this.outreachSentKeys = new Set((sent && sent.keys) || []);
            this.renderOutreachMode();
        } catch (e) { /* non-fatal */ }

        // Build filter query for the master (deduped) DB list
        const hasEmail = document.getElementById('outreachHasEmail');
        const priority = document.getElementById('outreachPriority');
        const params = new URLSearchParams({ limit: '500' });
        if (hasEmail && hasEmail.checked) params.set('hasContact', 'true');
        if (priority && priority.value) params.set('priority', priority.value);

        try {
            const data = await api.request(`/db/leads?${params.toString()}`);
            this.outreachLeads = (data.leads || []).map(row => ({
                key: row.dedup_key,
                name: row.name || '(no name)',
                email: row.email || '',
                phone: row.phone || '',
                website: row.website || row.page_url || '',
                score: row.score,
                priority: (row.priority || '').toUpperCase(),
                source: row.source || ''
            }));
            // Keep selections that still exist
            const keys = new Set(this.outreachLeads.map(l => l.key));
            this.outreachSelected = new Set([...this.outreachSelected].filter(k => keys.has(k)));

            const badge = document.getElementById('outreachCount');
            if (badge) badge.textContent = api.formatNumber(this.outreachLeads.filter(l => l.email).length);

            this.renderOutreachTable();
        } catch (error) {
            api.handleError(error, 'loading outreach leads');
            if (container) container.innerHTML = '<div class="card" style="text-align:center;padding:2rem"><p class="empty-title">Failed to load</p></div>';
        }
    }

    renderOutreachMode() {
        const el = document.getElementById('outreachModeBadge');
        if (!el) return;
        const p = this.outreachMode.provider;
        if (p === 'resend' || p === 'smtp') {
            el.innerHTML = `✅ <strong>Automated sending ON</strong> via ${p.toUpperCase()} — from ${this._escapeHtml(this.outreachMode.from || 'your account')}. Large batches send in the background; watch <a href="#" onclick="dashboard.setOutreachView('activity');return false">Activity</a>.`;
        } else {
            el.innerHTML = `✉️ <strong>Manual mode</strong> — "Send" opens pre-written drafts in your mail app (you click send). Add a <code>RESEND_API_KEY</code> (or SMTP) to send automatically at volume.`;
        }
    }

    setOutreachView(view) {
        this.outreachView = view;
        const compose = document.getElementById('outreachComposePanel');
        const activity = document.getElementById('outreachActivityPanel');
        if (compose) compose.style.display = view === 'compose' ? '' : 'none';
        if (activity) activity.style.display = view === 'activity' ? '' : 'none';
        const cBtn = document.getElementById('outreachTabCompose');
        const aBtn = document.getElementById('outreachTabActivity');
        if (cBtn) cBtn.className = `btn btn-sm ${view === 'compose' ? 'btn-primary' : 'btn-secondary'}`;
        if (aBtn) aBtn.className = `btn btn-sm ${view === 'activity' ? 'btn-primary' : 'btn-secondary'}`;
        if (view === 'activity') { this.loadOutreachStats(); this.loadOutreachLog(); }
    }

    _outreachVisible() {
        const q = (document.getElementById('outreachSearch')?.value || '').trim().toLowerCase();
        const hideContacted = document.getElementById('outreachHideContacted')?.checked;
        return this.outreachLeads.filter(l => {
            if (hideContacted && this.outreachSentKeys.has(l.key)) return false;
            if (q) {
                const hay = `${l.name} ${l.email}`.toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
    }

    renderOutreachTable() {
        const container = document.getElementById('outreachTableContainer');
        if (!container) return;
        const leads = this._outreachVisible();

        if (!leads.length) {
            container.innerHTML = `<div class="card" style="text-align:center;padding:2.5rem">
                <p class="empty-title">No leads to show</p>
                <p class="empty-message">Try unchecking "Only leads with an email", or find more leads first.</p></div>`;
            this.updateOutreachSelectionUI();
            return;
        }

        const rows = leads.map(l => {
            const contacted = this.outreachSentKeys.has(l.key);
            const hasDraft = !!this.outreachDrafts[l.key];
            const checked = this.outreachSelected.has(l.key) ? 'checked' : '';
            const pColor = api.getPriorityColor(l.priority);
            const status = contacted
                ? '<span style="color:var(--text-muted)">✓ Contacted</span>'
                : (hasDraft ? '<span style="color:var(--accent,#6366f1)">Draft ready</span>' : '—');
            const emailCell = l.email
                ? this._escapeHtml(l.email)
                : '<span style="color:var(--text-muted)">no email</span>';
            return `<tr data-key="${this._escapeHtml(l.key)}">
                <td style="padding:.55rem .75rem"><input type="checkbox" class="outreach-check" data-key="${this._escapeHtml(l.key)}" ${checked} ${l.email ? '' : 'disabled title="no email"'} /></td>
                <td style="padding:.55rem .75rem">${this._escapeHtml(l.name)}</td>
                <td style="padding:.55rem .75rem">${emailCell}</td>
                <td style="padding:.55rem .75rem">${l.score != null ? l.score : '—'}</td>
                <td style="padding:.55rem .75rem"><span style="display:inline-block;padding:.1rem .5rem;border-radius:99px;font-size:.72rem;font-weight:600;color:#fff;background:${pColor}">${l.priority || '—'}</span></td>
                <td style="padding:.55rem .75rem">${status}</td>
            </tr>`;
        }).join('');

        container.innerHTML = `<div class="card" style="padding:0;overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:.88rem">
                <thead><tr style="text-align:left;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em">
                    <th style="padding:.6rem .75rem;width:40px"></th>
                    <th style="padding:.6rem .75rem">Business</th>
                    <th style="padding:.6rem .75rem">Email</th>
                    <th style="padding:.6rem .75rem">Score</th>
                    <th style="padding:.6rem .75rem">Priority</th>
                    <th style="padding:.6rem .75rem">Status</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table></div>`;

        // Event delegation for row checkboxes
        const tbody = container.querySelector('tbody');
        if (tbody) {
            tbody.addEventListener('change', (e) => {
                const cb = e.target.closest('.outreach-check');
                if (!cb) return;
                const key = cb.dataset.key;
                if (cb.checked) this.outreachSelected.add(key);
                else this.outreachSelected.delete(key);
                this.updateOutreachSelectionUI();
            });
        }
        this.updateOutreachSelectionUI();
    }

    updateOutreachSelectionUI() {
        const n = this.outreachSelected.size;
        const label = document.getElementById('outreachSelectedCount');
        if (label) label.textContent = `${n} selected`;
        const visible = this._outreachVisible().filter(l => l.email);
        const all = document.getElementById('outreachSelectAll');
        if (all) all.checked = visible.length > 0 && visible.every(l => this.outreachSelected.has(l.key));
    }

    toggleSelectAllOutreach(checked) {
        const visible = this._outreachVisible().filter(l => l.email);
        for (const l of visible) {
            if (checked) this.outreachSelected.add(l.key);
            else this.outreachSelected.delete(l.key);
        }
        this.renderOutreachTable();
    }

    _selectedWithEmail() {
        return this.outreachLeads.filter(l => this.outreachSelected.has(l.key) && l.email);
    }

    async generateSelected() {
        const keys = [...this.outreachSelected];
        if (!keys.length) { showNotification('Nothing selected', 'Pick some leads first.', 'warning'); return; }
        return this._generateFor(keys);
    }

    async _generateFor(keys) {
        showNotification('Generating', `Writing ${keys.length} personalized email${keys.length === 1 ? '' : 's'}…`, 'info');
        try {
            const res = await api.request('/outreach/generate', {
                method: 'POST',
                body: JSON.stringify({ keys })
            });
            for (const r of (res.results || [])) {
                if (r.body) this.outreachDrafts[r.key] = { name: r.name, email: r.email, subject: r.subject, body: r.body };
            }
            const made = (res.results || []).filter(r => r.body).length;
            showNotification('Drafts ready', `${made} email${made === 1 ? '' : 's'} written. Review, edit, then send.`, 'success');
            this.renderOutreachTable();
            this.renderOutreachDrafts();
            return made;
        } catch (e) {
            api.handleError(e, 'generating drafts');
            return 0;
        }
    }

    renderOutreachDrafts() {
        const el = document.getElementById('outreachDrafts');
        if (!el) return;
        const keys = [...this.outreachSelected].filter(k => this.outreachDrafts[k]);
        if (!keys.length) { el.innerHTML = ''; return; }

        const cards = keys.map(k => {
            const d = this.outreachDrafts[k];
            const kEsc = this._escapeHtml(k);
            return `<div class="card" style="margin-bottom:1rem;padding:1rem" data-draftkey="${kEsc}">
                <div style="display:flex;align-items:baseline;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem">
                    <strong>${this._escapeHtml(d.name || '')}</strong>
                    <span style="color:var(--text-muted);font-size:.85rem">${this._escapeHtml(d.email || 'no email')}</span>
                    <button class="btn btn-primary btn-sm" style="margin-left:auto" data-sendone="${kEsc}">Send this</button>
                </div>
                <input type="text" class="draft-subject" data-key="${kEsc}" value="${this._escapeHtml(d.subject || '')}"
                    style="width:100%;margin-bottom:.5rem;padding:.5rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.88rem" />
                <textarea class="draft-body" data-key="${kEsc}" rows="7"
                    style="width:100%;padding:.5rem .6rem;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text);font-size:.88rem;font-family:inherit;resize:vertical">${this._escapeHtml(d.body || '')}</textarea>
            </div>`;
        }).join('');

        el.innerHTML = `<h3 style="margin-bottom:.75rem;font-size:1rem">Drafts (${keys.length}) — edit before sending</h3>${cards}`;

        // Keep edits in state
        el.querySelectorAll('.draft-subject').forEach(inp => {
            inp.addEventListener('input', e => { const d = this.outreachDrafts[e.target.dataset.key]; if (d) d.subject = e.target.value; });
        });
        el.querySelectorAll('.draft-body').forEach(ta => {
            ta.addEventListener('input', e => { const d = this.outreachDrafts[e.target.dataset.key]; if (d) d.body = e.target.value; });
        });
        el.querySelectorAll('[data-sendone]').forEach(btn => {
            btn.addEventListener('click', () => this.sendSelected([btn.dataset.sendone]));
        });
    }

    async sendSelected(explicitKeys) {
        let keys = explicitKeys || [...this.outreachSelected];
        const withEmail = this.outreachLeads.filter(l => keys.includes(l.key) && l.email);
        if (!withEmail.length) { showNotification('No emailable leads', 'Select leads that have an email address.', 'warning'); return; }

        // Auto-generate any missing drafts first
        const missing = withEmail.filter(l => !this.outreachDrafts[l.key]).map(l => l.key);
        if (missing.length) {
            const made = await this._generateFor(missing);
            if (!made && missing.length === withEmail.length) return; // nothing generated
        }

        const messages = withEmail
            .filter(l => this.outreachDrafts[l.key] && this.outreachDrafts[l.key].body)
            .map(l => ({ key: l.key, to: l.email, subject: this.outreachDrafts[l.key].subject, body: this.outreachDrafts[l.key].body }));
        if (!messages.length) { showNotification('Nothing to send', 'No drafts ready.', 'warning'); return; }

        try {
            const res = await api.request('/outreach/send', {
                method: 'POST',
                body: JSON.stringify({ messages })
            });

            if (res.mode === 'queued') {
                showNotification('Queued', `${res.queued} email${res.queued === 1 ? '' : 's'} queued — sending in the background via ${res.provider}. Watch Activity.`, 'success');
                messages.forEach(m => this.outreachSentKeys.add(m.key));
                this.setOutreachView('activity');
            } else if (res.mode === 'smtp') {
                showNotification('Sent', `${res.sent} sent${res.failed ? `, ${res.failed} failed` : ''}.`, res.failed ? 'warning' : 'success');
                messages.forEach(m => this.outreachSentKeys.add(m.key));
            } else {
                // Manual mode — open pre-addressed drafts in the mail client
                this._openMailtoDrafts(res.messages || messages);
            }
            this.renderOutreachTable();
        } catch (e) {
            api.handleError(e, 'sending outreach');
        }
    }

    _openMailtoDrafts(messages) {
        const cap = 15;
        const batch = messages.slice(0, cap);
        batch.forEach((m, i) => {
            setTimeout(() => {
                const url = `mailto:${encodeURIComponent(m.to)}?subject=${encodeURIComponent(m.subject || '')}&body=${encodeURIComponent(m.body || '')}`;
                window.open(url);
            }, i * 500);
        });
        showNotification('Opening drafts', `Opening ${batch.length} email${batch.length === 1 ? '' : 's'} in your mail app${messages.length > cap ? ` (first ${cap} of ${messages.length})` : ''}. Hit send in each.`, 'success');
        // Mark them contacted so they don't clog the list next time
        api.request('/outreach/mark', {
            method: 'POST',
            body: JSON.stringify({ items: batch.map(m => ({ key: m.key, to: m.to, subject: m.subject, body: m.body, status: 'sent' })) })
        }).then(() => batch.forEach(m => this.outreachSentKeys.add(m.key))).catch(() => {});
    }

    exportSelectedOutreach() {
        const rows = this.outreachLeads.filter(l => this.outreachSelected.has(l.key));
        if (!rows.length) { showNotification('Nothing selected', 'Select leads to export.', 'warning'); return; }
        const header = ['name', 'email', 'phone', 'website', 'score', 'priority', 'source'];
        const esc = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const csv = [header.join(',')]
            .concat(rows.map(l => [l.name, l.email, l.phone, l.website, l.score, l.priority, l.source].map(esc).join(',')))
            .join('\n');
        const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `outreach_selected_${rows.length}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        showNotification('Export', `Exported ${rows.length} leads.`, 'success');
    }

    // ─── Activity / Logs ────────────────────────────────────
    async loadOutreachStats() {
        try {
            const stats = await api.request('/outreach/stats');
            this.renderOutreachStats(stats);
        } catch (e) { /* non-fatal */ }
    }

    renderOutreachStats(stats) {
        const grid = document.getElementById('outreachStatsGrid');
        if (!grid) return;
        const cards = [
            { label: 'Queued', value: stats.queued || 0 },
            { label: 'Sent', value: (stats.sent || 0) + (stats.delivered || 0) + (stats.opened || 0) },
            { label: 'Delivered', value: stats.delivered || 0 },
            { label: 'Opened', value: stats.opened || 0 },
            { label: 'Failed', value: (stats.failed || 0) + (stats.bounced || 0) }
        ];
        grid.innerHTML = cards.map(c => `
            <div class="stat-card">
                <div class="stat-header"><span class="stat-label">${c.label}</span></div>
                <div class="stat-value">${api.formatNumber(c.value)}</div>
            </div>`).join('');
    }

    async loadOutreachLog() {
        const container = document.getElementById('outreachLogContainer');
        if (container) container.innerHTML = '<div class="card" style="text-align:center;padding:2rem"><p class="empty-title">Loading…</p></div>';
        try {
            const params = new URLSearchParams({ limit: '100' });
            if (this._outreachLogStatus) params.set('status', this._outreachLogStatus);
            const data = await api.request(`/outreach/log?${params.toString()}`);
            this.renderOutreachLog(data.rows || []);
        } catch (e) {
            api.handleError(e, 'loading activity log');
        }
    }

    _statusBadge(status) {
        const colors = {
            queued: '#f59e0b', sending: '#6366f1', sent: '#22d3ee',
            delivered: '#10b981', opened: '#10b981', failed: '#ef4444',
            bounced: '#ef4444', complained: '#ef4444', draft: '#64748b'
        };
        const c = colors[status] || '#64748b';
        return `<span style="display:inline-block;padding:.1rem .5rem;border-radius:99px;font-size:.72rem;font-weight:600;color:#fff;background:${c}">${this._escapeHtml(status || '—')}</span>`;
    }

    renderOutreachLog(rows) {
        const container = document.getElementById('outreachLogContainer');
        if (!container) return;
        if (!rows.length) {
            container.innerHTML = '<div class="card" style="text-align:center;padding:2.5rem"><p class="empty-title">No activity yet</p><p class="empty-message">Generate and send some emails from the Compose tab.</p></div>';
            return;
        }
        const body = rows.map(r => {
            const when = r.updated_at || r.sent_at || r.generated_at || '';
            const kEsc = this._escapeHtml(r.dedup_key);
            const canResend = ['sent', 'failed', 'delivered', 'opened', 'bounced'].includes(r.status);
            return `<tr>
                <td style="padding:.5rem .75rem">${this._escapeHtml(r.lead_name || r.to_email || '—')}</td>
                <td style="padding:.5rem .75rem">${this._escapeHtml(r.to_email || '—')}</td>
                <td style="padding:.5rem .75rem">${this._escapeHtml(r.subject || '—')}</td>
                <td style="padding:.5rem .75rem">${this._statusBadge(r.status)}${r.error ? ` <span title="${this._escapeHtml(r.error)}" style="color:#ef4444;cursor:help">⚠</span>` : ''}</td>
                <td style="padding:.5rem .75rem;white-space:nowrap;color:var(--text-muted);font-size:.8rem">${this._escapeHtml(api.formatDateSafe(when))}</td>
                <td style="padding:.5rem .75rem">${canResend ? `<button class="btn btn-secondary btn-sm outreach-resend" data-key="${kEsc}">Resend</button>` : ''}</td>
            </tr>`;
        }).join('');

        container.innerHTML = `<div class="card" style="padding:0;overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;font-size:.88rem">
                <thead><tr style="text-align:left;border-bottom:1px solid var(--border);color:var(--text-muted);font-size:.75rem;text-transform:uppercase;letter-spacing:.04em">
                    <th style="padding:.6rem .75rem">Lead</th>
                    <th style="padding:.6rem .75rem">Email</th>
                    <th style="padding:.6rem .75rem">Subject</th>
                    <th style="padding:.6rem .75rem">Status</th>
                    <th style="padding:.6rem .75rem">When</th>
                    <th style="padding:.6rem .75rem"></th>
                </tr></thead>
                <tbody>${body}</tbody>
            </table></div>`;

        container.querySelectorAll('.outreach-resend').forEach(btn => {
            btn.addEventListener('click', () => this.resendOne(btn.dataset.key, btn));
        });
    }

    async resendOne(key, btn) {
        if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
        try {
            const res = await api.request('/outreach/resend', {
                method: 'POST',
                body: JSON.stringify({ key })
            });
            if (res.mode === 'manual') {
                this._openMailtoDrafts([res.message]);
            } else {
                showNotification('Resend', 'Re-queued for sending.', 'success');
            }
            setTimeout(() => { this.loadOutreachStats(); this.loadOutreachLog(); }, 600);
        } catch (e) {
            api.handleError(e, 'resending');
            if (btn) { btn.disabled = false; btn.textContent = 'Resend'; }
        }
    }
}

// ─── Global: Export Lead vCard ──────────────────────────────
function exportLeadVCard(campaignId, leadIndex, leadName) {
    try {
        window.open(`/api/leads/${campaignId}/${leadIndex}/vcard`, '_blank');
        showNotification('vCard', `Downloading contact for ${leadName}`, 'success');
    } catch (error) {
        showNotification('Error', 'Failed to export vCard', 'error');
    }
}

// ─── Initialize ────────────────────────────────────────────
const dashboard = new Dashboard();