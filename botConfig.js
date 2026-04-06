const fs = require('fs');
const path = require('path');

// ─── Prompt File Loader ───────────────────────────────────────────────────────
function loadPromptFile(filename) {
    try {
        return fs.readFileSync(path.join(__dirname, 'prompts', filename), 'utf8');
    } catch (e) {
        console.error(`⚠️ Could not load prompts/${filename}:`, e.message);
        return '';
    }
}

// Replace {{key}} placeholders with values from links.json
function injectLinks(text, links) {
    return text.replace(/\{\{(\w+)\}\}/g, (_, key) => links[key] || `{{${key}}}`);
}

// ─── Links ────────────────────────────────────────────────────────────────────
function loadLinks() {
    try {
        return JSON.parse(loadPromptFile('links.json'));
    } catch (_) {
        console.error('⚠️ prompts/links.json missing or invalid');
        return {};
    }
}

// ─── Industries ───────────────────────────────────────────────────────────────
let INDUSTRY_NAMES = [];
let INDUSTRY_MAP = {};  // name (lowercase) → id, for API filtering

try {
    const industries = JSON.parse(loadPromptFile('industries.json'));
    industries.forEach(ind => {
        INDUSTRY_NAMES.push(ind.name);
        INDUSTRY_MAP[ind.name.toLowerCase()] = ind.id;
    });
} catch (_) {
    console.error('⚠️ prompts/industries.json missing or invalid');
}

// ─── Tool Definition ──────────────────────────────────────────────────────────
const tools = [{
    functionDeclarations: [{
        name: "search_jobs",
        description: `Search for job openings. Extract industry from: ${INDUSTRY_NAMES.join(', ')}.`,
        parameters: {
            type: "OBJECT",
            properties: {
                location: { type: "STRING", description: "City or location (e.g., Delhi, Mumbai)." },
                query:    { type: "STRING", description: "Job title or role (e.g., Accountant, Fitter)." },
                industry: { type: "STRING", description: `Industry if mentioned. One of: ${INDUSTRY_NAMES.join(', ')}.` }
            },
            required: ["location"]
        }
    }]
}];

// ─── System Prompt ────────────────────────────────────────────────────────────
const getSystemInstructions = () => {
    const links  = loadLinks();
    const prompt = injectLinks(loadPromptFile('system_prompt.txt'), links);

    return { role: "system", parts: [{ text: prompt }] };
};

module.exports = { INDUSTRY_MAP, tools, getSystemInstructions };
