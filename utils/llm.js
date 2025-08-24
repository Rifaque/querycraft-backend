/**
 * Simple LLM wrapper
 * - If process.env.LLM_ENDPOINT is set, it will POST { prompt } to that url and return .data
 * - Otherwise returns a mocked echo response (useful for local dev)
 */
const axios = require('axios');

async function generateResponse(prompt, options = {}) {
  const endpoint = process.env.LLM_ENDPOINT;
  if (!endpoint) {
    // mock
    return `MOCK_RESPONSE: ${prompt}`;
  }
  try {
    const resp = await axios.post(endpoint, { prompt, ...options }, { timeout: 20000 });
    // adapt depending on your LLM server response shape
    return resp.data.result || resp.data || JSON.stringify(resp.data);
  } catch (err) {
    console.error('LLM call error:', err.message || err);
    return `LLM_ERROR: ${err.message || 'failed to call LLM'}`;
  }
}

module.exports = { generateResponse };
