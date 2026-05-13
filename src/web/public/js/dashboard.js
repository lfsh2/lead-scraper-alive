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

        this.init();
    }

    async init() {
        this.initTheme();
        this.setupEventListeners();
        this.setupMobileNav();
        this.setupRealTimeUpdates();
        this.progressManager = new ProgressManager('campaignProgressModal');

        await this.loadAllLeads();
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
        }
    }

    // ═══════════════════════════════════════════════════════
    // DATA LOADING — leads-only, aggregated across all searches
    // ═══════════════════════════════════════════════════════

    async loadAllLeads() {
        try {
            const campaigns = await api.getCampaigns();
            this.campaigns = campaigns;

            // Fetch every campaign's leads in parallel and stamp source metadata
            const results = await Promise.all(campaigns.map(async (c) => {
                try {
                    const data = await api.getLeads(c.id);
                    return (data.leads || []).map((lead, index) => ({
                        ...lead,
                        _source: { id: c.id, name: c.name, index, executedAt: c.executedAt }
                    }));
                } catch (e) {
                    return [];
                }
            }));

            this.allLeads = results.flat();
            // Newest first (by source executedAt)
            this.allLeads.sort((a, b) => {
                const ta = new Date(a._source?.executedAt || 0).getTime();
                const tb = new Date(b._source?.executedAt || 0).getTime();
                return tb - ta;
            });
            this.filteredLeads = this.allLeads;

            this.renderLeadStats();
            this.populateSearchFilter();
            this._applyFilters();

            const badge = document.getElementById('leadCount');
            if (badge) badge.textContent = api.formatNumber(this.allLeads.length);

            const exportBtn = document.getElementById('exportVCardBtn');
            if (exportBtn) exportBtn.style.display = this.allLeads.length ? '' : 'none';
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

    // Filter state — combined search text + search-name + min score
    _filterState = { query: '', searchId: '', minScore: 0 };

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
        const { query, searchId, minScore } = this._filterState;
        this.filteredLeads = this.allLeads.filter(l => {
            if (searchId && l._source?.id !== searchId) return false;
            if (minScore > 0 && Number(l.intelligence?.score || 0) < minScore) return false;
            if (query) {
                const hay = [l.name, l.phone, l.address, l.website, l._source?.name]
                    .filter(Boolean).join(' ').toLowerCase();
                if (!hay.includes(query)) return false;
            }
            return true;
        });
        this.renderLeadsTable(this.filteredLeads);
        const strip = document.getElementById('leadCountStrip');
        if (strip) {
            strip.textContent = `${this.filteredLeads.length} of ${this.allLeads.length} shown`;
        }
    }

    populateSearchFilter() {
        const select = document.getElementById('leadsSearchFilter');
        if (!select || !this.campaigns) return;
        const current = select.value;
        const opts = ['<option value="">All searches</option>']
            .concat(this.campaigns.map(c => {
                const count = this.allLeads.filter(l => l._source?.id === c.id).length;
                const label = `${c.name} (${count})`;
                return `<option value="${c.id}">${this._escapeHtml(label)}</option>`;
            }));
        select.innerHTML = opts.join('');
        if (current && this.campaigns.some(c => c.id === current)) select.value = current;
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

        const total = this.allLeads.length;
        const priority = this.allLeads.filter(l => (l.intelligence?.priority || '').toUpperCase() === 'HIGH').length;
        const withPhone = this.allLeads.filter(l => l.phone).length;
        const scores = this.allLeads.map(l => Number(l.intelligence?.score)).filter(n => !isNaN(n));
        const avgScore = scores.length ? Math.round(scores.reduce((a,b) => a+b, 0) / scores.length) : 0;

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
                    <span class="stat-label">High Priority</span>
                    <div class="stat-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                    </div>
                </div>
                <div class="stat-value">${api.formatNumber(priority)}</div>
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
                { key: 'website', title: 'Link', type: 'link' },
                { key: 'platforms', title: 'Platforms', type: 'tags' },
                { key: 'intelligence.score', title: 'Score', type: 'score' },
                { key: 'intelligence.priority', title: 'Priority', type: 'priority' },
                { key: '_source.name', title: 'Search', type: 'text' },
                { key: 'actions', title: 'Actions', type: 'actions' }
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

        if (!campaignData.name || !campaignData.industry || !campaignData.location || !campaignData.searchQuery || !campaignData.yourService) {
            showNotification('Validation Error', 'Please fill in all required fields', 'warning');
            return;
        }

        try {
            hideModal();
            this.progressManager.show(campaignData.name);

            const result = await api.createCampaign(campaignData);

            if (result.success) {
                showNotification('Search started', `Looking for leads matching "${campaignData.name}"`, 'success');
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

    exportAllCsv() {
        if (!this.allLeads || this.allLeads.length === 0) {
            showNotification('Export', 'No leads to export yet', 'warning');
            return;
        }
        // If a single search is selected, use its dedicated endpoint —
        // otherwise export every unique lead across every run.
        const selected = (this._filterState && this._filterState.searchId) || '';
        if (selected) {
            window.open(`/api/campaigns/${encodeURIComponent(selected)}/export/csv`, '_blank');
            const c = (this.campaigns || []).find(x => x.id === selected);
            showNotification('Export', `Downloading CSV for "${c ? c.name : selected}"…`, 'success');
        } else {
            window.open('/api/leads/export/csv', '_blank');
            showNotification('Export', `Downloading CSV of all ${this.allLeads.length} leads…`, 'success');
        }
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