/**
 * Simple LLM wrapper
 * - If process.env.LLM_ENDPOINT is set, it will POST { prompt } to that url and return .data
 * - Otherwise returns a mocked echo response (useful for local dev)
 */
// utils/llm.js
const axios = require('axios');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT; // e.g. http://localhost:8000/v1/chat or custom LLM

/**
 * Query LLM. If LLM_ENDPOINT is set, it will POST to that endpoint (expects JSON { prompt, model, max_tokens }).
 * Otherwise it will use OpenAI Chat Completions (requires OPENAI_API_KEY).
 *
 * Returns { text, raw, usage } where `raw` is the full provider response.
 */
async function queryLLM({ prompt, model = 'gpt-4o-mini', max_tokens = 512, temperature = 0.2 }) {
  if (!prompt || !prompt.trim()) throw new Error('Empty prompt');

  // Prefer user-provided LLM endpoint (self-hosted)
  if (LLM_ENDPOINT) {
    const payload = { prompt, model, max_tokens, temperature };
    const resp = await axios.post(LLM_ENDPOINT, payload, {
      timeout: 120000
    });
    // try to extract text in flexible ways
    const raw = resp.data;
    let text = '';
    if (typeof raw === 'string') text = raw;
    else if (raw.output || raw.result) text = raw.output || raw.result;
    else if (raw.choices && raw.choices[0]) text = raw.choices[0].text || raw.choices[0].message?.content || '';
    else text = JSON.stringify(raw).slice(0, 1000);
    return { text, raw, usage: raw.usage || null };
  }

  // Fallback to OpenAI
  if (!OPENAI_KEY) throw new Error('No LLM endpoint configured (set LLM_ENDPOINT or OPENAI_API_KEY)');

  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: prompt }
    ],
    max_tokens,
    temperature
  };

  const resp = await axios.post(OPENAI_URL, body, {
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json'
    },
    timeout: 120000
  });

  const raw = resp.data;
  const text = (raw?.choices && raw.choices[0]?.message?.content) || (raw?.choices && raw.choices[0]?.text) || '';
  const usage = raw?.usage || null;

  return { text, raw, usage };
}

module.exports = { queryLLM };

