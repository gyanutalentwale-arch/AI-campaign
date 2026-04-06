const axios = require('axios');
const { INDUSTRY_MAP } = require('../../botConfig');

function findIndustryId(industryName) {
    if (!industryName || typeof industryName !== 'string') return null;
    const search = industryName.toLowerCase().trim();
    if (INDUSTRY_MAP[search]) return INDUSTRY_MAP[search];
    for (const [key, id] of Object.entries(INDUSTRY_MAP)) {
        if (key.includes(search) || search.includes(key)) return id;
    }
    return null;
}

// Talentwale Job Search API
async function searchJobsFromApi(location, query, industry) {
    console.log(`Searching jobs: ${query} in ${location} (Industry: ${industry})`);
    try {
        const industryId = findIndustryId(industry);
        const normalizeText = (value, fallback = '') =>
            String(value == null ? fallback : value).trim();

        // We fetch 100 jobs because Talentwale API uses internal IDs for location_id/job_role_id.
        // We bypass text filters on the payload to prevent it from returning empty data blindly,
        // then filter locally.
        const payload = {
            page: 1, limit: 100, sort_by: 'desc',
            location_id: [],
            company_type: null, industry_id: industryId ? [industryId] : null, company_id: null,
            department_id: null, salary_range: null, experience: null,
            skill_id: null, desgination_id: null, employment_type: null,
            work_type: null, gender: null, posted_date: ''
        };

        const response = await axios.post('https://production.talentwale.com/api/jobs/listing', payload, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                'Origin': 'https://talentwale.com',
                'Referer': 'https://talentwale.com/',
                'Content-Type': 'application/json',
                'Accept': 'application/json, text/plain, */*'
            }
        });

        if (response.data && response.data.data && Array.isArray(response.data.data)) {
            let simplifiedJobs = response.data.data.map(job => ({
                title: normalizeText(job.jobname?.name, 'Job Role'),
                company: normalizeText(job.company?.name, 'Company'),
                location: normalizeText(job.location?.city || job.location?.name, 'Location'),
                salary: (job.min_pay && job.max_pay) ? `${job.min_pay} - ${job.max_pay}` : normalizeText(job.exact_pay, 'Not Disclosed'),
                link: `https://talentwale.com/job-details?jid=${job.job_unique_id}`
            }));

            // Locally filter by query (job role)
            if (query) {
                const qMatch = query.toLowerCase().trim();
                simplifiedJobs = simplifiedJobs.filter(j =>
                    String(j.title || '').toLowerCase().includes(qMatch) ||
                    String(j.company || '').toLowerCase().includes(qMatch)
                );
            }

            // Locally filter by location
            if (location) {
                const lMatch = location.toLowerCase().trim();
                simplifiedJobs = simplifiedJobs.filter(j =>
                    String(j.location || '').toLowerCase().includes(lMatch)
                );
            }

            // Return top 3 matches to keep WhatsApp clean
            return { jobs: simplifiedJobs.slice(0, 3) };
        }
        return { jobs: [] };
    } catch (error) {
        console.error('API Error:', error.message);
        return { error: 'Unable to fetch jobs at the moment.' };
    }
}

module.exports = { searchJobsFromApi };
