const axios = require("axios");

module.exports = function createTalentwaleCandidateService({ addLog = () => {} } = {}) {
  const credentials = {
    email: process.env.TALENTWALE_ADMIN_EMAIL || "Dataentry3.intelliworkz@gmail.com",
    password: process.env.TALENTWALE_ADMIN_PASSWORD || "Gyanu@123",
    role: process.env.TALENTWALE_ADMIN_ROLE || "admin",
  };

  async function login() {
    try {
      const response = await axios.post("https://production.talentwale.com/api/login", credentials);
      const token = response?.data?.api_token;
      if (!token) {
        throw new Error("No token in response");
      }
      addLog("info", "Connected to Talentwale API successfully.");
      return token;
    } catch (error) {
      addLog("warn", `Talentwale API login failed: ${error.message}`);
      throw error;
    }
  }

  function normalizeDigits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function buildPhoneVariants(candidate = {}) {
    const phone = normalizeDigits(candidate.phone);
    const countryCode = normalizeDigits(candidate.country_code);
    const variants = new Set();

    if (phone) {
      variants.add(phone);
      variants.add(phone.slice(-10));
      if (countryCode) {
        variants.add(countryCode + phone);
        variants.add((countryCode + phone).slice(-10));
      }
    }

    return variants;
  }

  function buildCandidateSummary(candidate = {}) {
    return {
      id: candidate.id || null,
      uniqueCode: candidate.unique_code || "",
      name: candidate.name || "",
      phone: candidate.phone || "",
      countryCode: candidate.country_code || "",
      email: candidate.email || "",
      role: candidate.role || "",
    };
  }

  function findCandidateMatch(candidates = [], searchQuery) {
    const query = String(searchQuery || "").trim();
    if (!query) return null;

    const queryDigits = normalizeDigits(query);
    const queryLower = query.toLowerCase();
    const isEmailQuery = queryLower.includes("@");

    for (const candidate of candidates) {
      if (isEmailQuery) {
        const candidateEmail = String(candidate?.email || "").trim().toLowerCase();
        if (candidateEmail && candidateEmail === queryLower) {
          return {
            found: true,
            matchType: "email",
            candidate: buildCandidateSummary(candidate),
          };
        }
        continue;
      }

      if (!queryDigits) continue;
      const variants = buildPhoneVariants(candidate);
      if (
        variants.has(queryDigits) ||
        variants.has(queryDigits.slice(-10)) ||
        [...variants].some((value) => value && value.slice(-10) === queryDigits.slice(-10))
      ) {
        return {
          found: true,
          matchType: "phone",
          candidate: buildCandidateSummary(candidate),
        };
      }
    }

    return null;
  }

  async function searchCandidates(token, searchQuery) {
    if (!token || !searchQuery) return [];

    try {
      const response = await axios.post(
        "https://production.talentwale.com/api/admin/candidate/list",
        {
          page: 1,
          startDate: "",
          endDate: "",
          registrationBy: "",
          limit: 10,
          search: String(searchQuery),
        },
        {
          headers: {
            authorization: `Bearer ${token}`,
          },
        },
      );

      return Array.isArray(response?.data?.data) ? response.data.data : [];
    } catch (error) {
      addLog("warn", `Talentwale search error for ${searchQuery}: ${error.message}`);
      throw error;
    }
  }

  async function createSession() {
    const token = await login();
    return {
      async hasCandidate(searchQuery) {
        const candidates = await searchCandidates(token, searchQuery);
        return Boolean(findCandidateMatch(candidates, searchQuery));
      },

      async findCandidate(searchQuery) {
        const candidates = await searchCandidates(token, searchQuery);
        return findCandidateMatch(candidates, searchQuery);
      },
    };
  }

  return {
    createSession,
  };
};
