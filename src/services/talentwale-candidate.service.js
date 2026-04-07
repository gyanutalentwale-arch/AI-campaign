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

  async function searchCandidate(token, searchQuery) {
    if (!token || !searchQuery) return false;

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

      return Array.isArray(response?.data?.data) && response.data.data.length > 0;
    } catch (error) {
      addLog("warn", `Talentwale search error for ${searchQuery}: ${error.message}`);
      throw error;
    }
  }

  async function createSession() {
    const token = await login();
    return {
      async hasCandidate(searchQuery) {
        return searchCandidate(token, searchQuery);
      },
    };
  }

  return {
    createSession,
  };
};
