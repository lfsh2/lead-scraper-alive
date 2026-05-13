class LeadIntelligence {
    constructor(options = {}) {
        // Accept custom overrides, but keep defaults
        this.industryScores = {
            ...this._getDefaultIndustryScores(),
            ...(options.industryScores || {})
        };
        this.locationScores = {
            ...this._getDefaultLocationScores(),
            ...(options.locationScores || {})
        };
    }

    _getDefaultIndustryScores() {
        return {
            restaurant: { potential: 85, digitalReadiness: 75, urgency: 90 },
            automotive: { potential: 90, digitalReadiness: 70, urgency: 85 },
            retail: { potential: 95, digitalReadiness: 80, urgency: 95 },
            professional: { potential: 80, digitalReadiness: 85, urgency: 75 },
            healthcare: { potential: 85, digitalReadiness: 65, urgency: 80 },
            education: { potential: 75, digitalReadiness: 70, urgency: 85 },
            realestate: { potential: 90, digitalReadiness: 75, urgency: 80 }
        };
    }

    _getDefaultLocationScores() {
        return {
            jakarta: { economy: 95, digital: 90, competition: 85 },
            bandung: { economy: 80, digital: 75, competition: 70 },
            surabaya: { economy: 85, digital: 80, competition: 75 },
            medan: { economy: 75, digital: 70, competition: 65 },
            yogyakarta: { economy: 70, digital: 75, competition: 60 },
            default: { economy: 65, digital: 60, competition: 55 }
        };
    }

    async scoreLeads(leads, industry = 'professional') {
        console.log(`\n🧠 Lead Intelligence: Analyzing ${leads.length} leads...`);
        
        const scoredLeads = leads.map(lead => {
            const score = this.calculateLeadScore(lead, industry);
            return {
                ...lead,
                intelligence: {
                    score: score.total,
                    category: this.categorizeScore(score.total),
                    factors: score.factors,
                    recommendation: this.getRecommendation(score.total),
                    priority: this.getPriority(score.total)
                }
            };
        });

        // Sort by score descending
        scoredLeads.sort((a, b) => b.intelligence.score - a.intelligence.score);

        this.generateInsightsReport(scoredLeads, industry);
        
        return scoredLeads;
    }

    calculateLeadScore(lead, industry) {
        const isMeta = /Meta|Facebook|Instagram/i.test(lead.source || '');

        const factors = {
            dataCompleteness: this.scoreDataCompleteness(lead),
            businessQuality: this.scoreBusinessQuality(lead),
            digitalPresence: this.scoreDigitalPresence(lead),
            locationValue: this.scoreLocation(lead),
            industryPotential: this.scoreIndustryPotential(industry),
            contactability: this.scoreContactability(lead),
            faithSignal: this.scoreFaithSignal(lead),
            adActivity: this.scoreAdActivity(lead)
        };

        // Meta sources lack phone/address/rating; rebalance so they're not unfairly penalized.
        const weights = isMeta
            ? {
                  dataCompleteness: 0.05,
                  businessQuality: 0.10,
                  digitalPresence: 0.20,
                  locationValue: 0.05,
                  industryPotential: 0.10,
                  contactability: 0.05,
                  faithSignal: 0.25,
                  adActivity: 0.20
              }
            : {
                  dataCompleteness: 0.15,
                  businessQuality: 0.20,
                  digitalPresence: 0.15,
                  locationValue: 0.10,
                  industryPotential: 0.10,
                  contactability: 0.10,
                  faithSignal: 0.20,
                  adActivity: 0.00
              };

        let total = 0;
        for (const [factor, score] of Object.entries(factors)) {
            total += score * (weights[factor] || 0);
        }

        return {
            total: Math.round(total),
            factors: factors
        };
    }

    scoreFaithSignal(lead) {
        const haystack = [
            lead.name,
            lead.description,
            lead.website,
            lead.pageUrl,
            lead.creative
        ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();

        if (!haystack) return 30;

        // Strong faith signals — explicit faith-based positioning
        const strong = [
            'faith based', 'faith-based', 'christian coach', 'christian life coach',
            'kingdom', 'biblical', 'ministry', 'jesus', 'gospel', 'discipleship',
            'pastor', 'pastoral', 'prayer', 'spirit-led', 'spirit led', 'god-given',
            'great commission', 'born again', 'scripture'
        ];
        // Soft signals — coach with faith-adjacent vocabulary
        const soft = [
            'faith', 'christian', 'christ', 'church', 'spiritual', 'purpose',
            'calling', 'mission', 'holistic', 'soul', 'redemption', 'wholeness'
        ];
        // Coach role signals — confirms they're in the coaching space at all
        const coachRole = [
            'coach', 'coaching', 'mentor', 'mentorship', 'consultant', 'counselor',
            'counsellor', 'therapist', 'advisor'
        ];

        const hasCoach = coachRole.some(t => haystack.includes(t));
        const strongHits = strong.filter(t => haystack.includes(t)).length;
        const softHits = soft.filter(t => haystack.includes(t)).length;

        let score = 30; // baseline if nothing matches
        if (hasCoach) score += 25;
        score += Math.min(strongHits * 15, 45);
        score += Math.min(softHits * 5, 20);
        if (hasCoach && strongHits >= 1) score += 10; // bonus combo: coach + faith
        return Math.min(score, 100);
    }

    scoreAdActivity(lead) {
        // Higher score for leads who are actively running ads — they spend on marketing.
        if (!lead.libraryId && !/Meta Ad Library/i.test(lead.source || '')) return 0;
        let score = 70;
        const platforms = lead.platforms || [];
        if (platforms.length >= 2) score += 10;
        if (platforms.includes('Instagram')) score += 5;
        if (lead.startedRunningOn) {
            // Recent campaigns score higher
            try {
                const started = new Date(lead.startedRunningOn);
                const daysAgo = (Date.now() - started.getTime()) / 86400000;
                if (daysAgo < 30) score += 15;
                else if (daysAgo < 90) score += 8;
            } catch (_) {}
        }
        return Math.min(score, 100);
    }

    scoreDataCompleteness(lead) {
        let score = 0;
        const maxScore = 100;
        
        if (lead.name && lead.name.trim()) score += 25;
        if (lead.address && lead.address.trim()) score += 20;
        if (lead.phone && lead.phone.trim()) score += 25;
        if (lead.website && lead.website.trim() && lead.website !== 'N/A') score += 15;
        if (lead.rating && !isNaN(lead.rating)) score += 10;
        if (lead.email && lead.email.trim()) score += 5;

        return Math.min(score, maxScore);
    }

    scoreBusinessQuality(lead) {
        let score = 50; // Base score
        
        // Rating factor
        if (lead.rating) {
            const rating = parseFloat(lead.rating);
            if (rating >= 4.5) score += 30;
            else if (rating >= 4.0) score += 20;
            else if (rating >= 3.5) score += 10;
            else if (rating < 3.0) score -= 10;
        }

        // Business name quality
        if (lead.name) {
            const name = lead.name.toLowerCase();
            if (name.includes('official') || name.includes('group') || name.includes('center')) {
                score += 10;
            }
            if (name.length > 30) score -= 5; // Too long might be weird
            if (name.length < 5) score -= 10; // Too short might be incomplete
        }

        // Address quality (more specific = better)
        if (lead.address) {
            const address = lead.address.toLowerCase();
            if (address.includes('jl.') || address.includes('jalan')) score += 5;
            if (address.includes('jakarta') || address.includes('bandung') || address.includes('surabaya')) score += 5;
            if (address.includes('mall') || address.includes('plaza') || address.includes('tower')) score += 10;
        }

        return Math.min(Math.max(score, 0), 100);
    }

    scoreDigitalPresence(lead) {
        let score = 20; // Base score for being found online

        if (lead.website && lead.website !== 'N/A') {
            score += 40;
            const website = lead.website.toLowerCase();

            // Domain quality
            if (website.includes('.com') || website.includes('.co.id')) score += 10;
            // Meta-only presence is still a real signal for our outreach motion
            if (website.includes('instagram.com') || website.includes('facebook.com')) score += 15;
            else if (website.includes('http')) score += 15; // Proper website
        }

        // Bonus for multi-platform Meta ad presence (cross-channel marketer)
        if (Array.isArray(lead.platforms) && lead.platforms.length >= 2) score += 10;

        // Social media presence indicators
        if (lead.description) {
            const desc = lead.description.toLowerCase();
            if (desc.includes('instagram') || desc.includes('facebook')) score += 10;
            if (desc.includes('whatsapp') || desc.includes('wa')) score += 5;
        }

        // Phone presence (shows they want to be contacted)
        if (lead.phone) score += 15;

        return Math.min(score, 100);
    }

    scoreLocation(lead) {
        if (!lead.address) return 50;
        
        const address = lead.address.toLowerCase();
        
        // Jakarta and suburbs
        if (address.includes('jakarta') || address.includes('depok') || 
            address.includes('tangerang') || address.includes('bekasi')) {
            return this.locationScores.jakarta.economy;
        }
        
        // Major cities
        if (address.includes('bandung')) return this.locationScores.bandung.economy;
        if (address.includes('surabaya')) return this.locationScores.surabaya.economy;
        if (address.includes('medan')) return this.locationScores.medan.economy;
        if (address.includes('yogyakarta') || address.includes('jogja')) return this.locationScores.yogyakarta.economy;
        
        // Default for other locations
        return this.locationScores.default.economy;
    }

    scoreIndustryPotential(industry) {
        const industryData = this.industryScores[industry];
        if (!industryData) return 70;
        
        return Math.round(
            (industryData.potential + industryData.digitalReadiness + industryData.urgency) / 3
        );
    }

    scoreContactability(lead) {
        let score = 0;
        
        if (lead.phone) {
            score += 50;
            // Indonesian mobile numbers are more contactable
            if (lead.phone.includes('08') || lead.phone.includes('+62')) score += 20;
        }
        
        if (lead.email) score += 20;
        if (lead.website && lead.website !== 'N/A') score += 10;
        
        return Math.min(score, 100);
    }

    categorizeScore(score) {
        if (score >= 85) return 'A+ (Excellent)';
        if (score >= 75) return 'A (High Quality)';
        if (score >= 65) return 'B (Good)';
        if (score >= 55) return 'C (Average)';
        return 'D (Low Priority)';
    }

    getRecommendation(score) {
        if (score >= 85) return 'Priority lead - contact immediately with premium approach';
        if (score >= 75) return 'High-value lead - personalized outreach recommended';
        if (score >= 65) return 'Good prospect - standard campaign approach';
        if (score >= 55) return 'Qualified lead - nurture with content';
        return 'Low priority - minimal resource allocation';
    }

    getPriority(score) {
        if (score >= 85) return 'HIGH';
        if (score >= 65) return 'MEDIUM';
        return 'LOW';
    }

    generateInsightsReport(scoredLeads, industry) {
        const stats = this.calculateStats(scoredLeads);
        
        console.log('\n📊 Lead Intelligence Report');
        console.log('═'.repeat(50));
        console.log(`Industry: ${industry.toUpperCase()}`);
        console.log(`Total Leads: ${scoredLeads.length}`);
        console.log(`Average Score: ${stats.averageScore}`);
        console.log(`High Priority: ${stats.highPriority} leads`);
        console.log(`Medium Priority: ${stats.mediumPriority} leads`);
        console.log(`Low Priority: ${stats.lowPriority} leads`);
        
        console.log('\n🏆 Top 5 Prospects:');
        console.log('─'.repeat(30));
        scoredLeads.slice(0, 5).forEach((lead, index) => {
            console.log(`${index + 1}. ${lead.name} (Score: ${lead.intelligence.score})`);
            console.log(`   Category: ${lead.intelligence.category}`);
            console.log(`   Recommendation: ${lead.intelligence.recommendation}`);
            console.log('');
        });

        console.log('💡 Insights:');
        console.log('─'.repeat(15));
        this.generateActionableInsights(stats, scoredLeads);
    }

    calculateStats(scoredLeads) {
        const scores = scoredLeads.map(lead => lead.intelligence.score);
        const averageScore = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
        
        const highPriority = scoredLeads.filter(lead => lead.intelligence.priority === 'HIGH').length;
        const mediumPriority = scoredLeads.filter(lead => lead.intelligence.priority === 'MEDIUM').length;
        const lowPriority = scoredLeads.filter(lead => lead.intelligence.priority === 'LOW').length;

        return {
            averageScore,
            highPriority,
            mediumPriority,
            lowPriority,
            maxScore: Math.max(...scores),
            minScore: Math.min(...scores)
        };
    }

    generateActionableInsights(stats, scoredLeads) {
        // Data completeness insights
        const incompleteData = scoredLeads.filter(lead => 
            lead.intelligence.factors.dataCompleteness < 70
        ).length;
        
        if (incompleteData > scoredLeads.length * 0.3) {
            console.log(`• ${incompleteData} leads have incomplete data - consider data enrichment`);
        }

        // Digital presence insights  
        const lowDigital = scoredLeads.filter(lead => 
            lead.intelligence.factors.digitalPresence < 50
        ).length;
        
        if (lowDigital > 0) {
            console.log(`• ${lowDigital} leads have low digital presence - good digitalization prospects`);
        }

        // High-value opportunities
        if (stats.highPriority > 0) {
            console.log(`• Focus on ${stats.highPriority} high-priority leads for immediate outreach`);
        }

        // Campaign recommendations
        if (stats.averageScore < 60) {
            console.log('• Overall lead quality is low - consider refining search criteria');
        } else if (stats.averageScore > 80) {
            console.log('• Excellent lead quality - high conversion potential expected');
        }
    }

    filterLeadsByScore(scoredLeads, minScore = 60) {
        return scoredLeads.filter(lead => lead.intelligence.score >= minScore);
    }

    getLeadsByPriority(scoredLeads, priority = 'HIGH') {
        return scoredLeads.filter(lead => lead.intelligence.priority === priority);
    }

    exportIntelligenceReport(scoredLeads, filename = 'lead_intelligence_report') {
        const timestamp = new Date().toISOString().split('T')[0];
        const reportData = {
            generatedAt: new Date().toISOString(),
            totalLeads: scoredLeads.length,
            stats: this.calculateStats(scoredLeads),
            leads: scoredLeads.map(lead => ({
                name: lead.name,
                address: lead.address,
                phone: lead.phone,
                score: lead.intelligence.score,
                category: lead.intelligence.category,
                priority: lead.intelligence.priority,
                recommendation: lead.intelligence.recommendation
            }))
        };

        const fs = require('fs');
        const outputPath = `${filename}_${timestamp}.json`;
        fs.writeFileSync(outputPath, JSON.stringify(reportData, null, 2));
        
        console.log(`📄 Intelligence report saved: ${outputPath}`);
        return outputPath;
    }
}

module.exports = LeadIntelligence;