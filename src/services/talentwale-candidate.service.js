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

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function toLast10Digits(value) {
    return normalizeDigits(value).slice(-10);
  }

  function normalizeSearchInput(searchInput) {
    if (searchInput && typeof searchInput === "object" && !Array.isArray(searchInput)) {
      return {
        phone: toLast10Digits(searchInput.phone || searchInput.number || searchInput.mobile),
        email: normalizeEmail(searchInput.email),
      };
    }

    const query = String(searchInput || "").trim();
    if (!query) {
      return { phone: "", email: "" };
    }

    if (query.includes("@")) {
      return { phone: "", email: normalizeEmail(query) };
    }

    return { phone: toLast10Digits(query), email: "" };
  }

  function getCandidatePhoneLast10(candidate = {}) {
    return toLast10Digits(candidate.phone || `${candidate.country_code || ""}${candidate.phone || ""}`);
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

  function findPhoneCandidateMatch(candidates = [], phone) {
    const phoneLast10 = toLast10Digits(phone);
    if (!phoneLast10) return null;

    for (const candidate of candidates) {
      if (getCandidatePhoneLast10(candidate) === phoneLast10) {
        return {
          found: true,
          matchType: "phone",
          candidate: buildCandidateSummary(candidate),
        };
      }
    }

    return null;
  }

  function findEmailCandidateMatch(candidates = [], email) {
    const normalizedEmail = normalizeEmail(email);
    if (!normalizedEmail) return null;

    for (const candidate of candidates) {
      const candidateEmail = normalizeEmail(candidate?.email);
      if (candidateEmail && candidateEmail === normalizedEmail) {
        return {
          found: true,
          matchType: "email",
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

  async function lookupCandidate(token, searchInput) {
    const { phone, email } = normalizeSearchInput(searchInput);

    if (phone) {
      const phoneCandidates = await searchCandidates(token, phone);
      const phoneMatch = findPhoneCandidateMatch(phoneCandidates, phone);
      if (phoneMatch) return phoneMatch;
    }

    if (email) {
      const emailCandidates = await searchCandidates(token, email);
      const emailMatch = findEmailCandidateMatch(emailCandidates, email);
      if (emailMatch) return emailMatch;
    }

    return null;
  }

  async function createSession() {
    const token = await login();
    return {
      async hasCandidate(searchInput) {
        return Boolean(await lookupCandidate(token, searchInput));
      },

      async findCandidate(searchInput) {
        return lookupCandidate(token, searchInput);
      },
    };
  }

  return {
    createSession,
  };
};
