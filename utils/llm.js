// utils/llm.js
const axios = require('axios');
const { parseLLMResponseText } = require('../utils/responseParser');

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const LLM_ENDPOINT = process.env.LLM_ENDPOINT || 'http://127.0.0.1:11434/api/generate';
const DEFAULT_MODEL = process.env.DEFAULT_MODEL || 'mistral:7b-instruct';

// Simple whitelist / mapping to avoid arbitrary model strings from client
const MODEL_MAP = {
  'mistral': 'mistral:7b-instruct',
  'mistral:7b-instruct': 'mistral:7b-instruct',
  'mistral:7b': 'mistral:7b',
  'qwen4': 'qwen:4b',
  'qwen:4b': 'qwen:4b',
  'llama1b': 'llama3.2:1b',
  'llama3.2:1b': 'llama3.2:1b'
};

function normalizeModel(input) {
  if (!input) return DEFAULT_MODEL;
  const key = String(input).trim();
  if (MODEL_MAP[key]) return MODEL_MAP[key];
  const lower = key.toLowerCase();
  if (MODEL_MAP[lower]) return MODEL_MAP[lower];
  return DEFAULT_MODEL;
}

/**
 * Query LLM. If LLM_ENDPOINT is set (default points to local Ollama),
 * it will POST { prompt, model, max_tokens, temperature } to that url.
 * Otherwise falls back to OpenAI Chat Completions.
 *
 * Returns { text, raw, usage, sql? }
 */
async function queryLLM({ prompt, model = null, max_tokens = 512, temperature = 0.2 }) {
  if (!prompt || !prompt.trim()) throw new Error('Empty prompt');

  const chosenModel = normalizeModel(model);

  // Helper to try multiple places in the raw response for the "actual" text
  function extractPossibleTextFromRaw(raw) {
    if (raw == null) return '';

    // If raw is already a string, that's candidate (may be JSON-encoded)
    if (typeof raw === 'string') return raw;

    // Common top-level fields
    if (typeof raw.text === 'string') return raw.text;
    if (typeof raw.response === 'string') return raw.response;
    if (typeof raw.output === 'string') return raw.output;
    if (typeof raw.result === 'string') return raw.result;

    // Some endpoints return { data: { text: '...' } }
    if (raw.data && typeof raw.data.text === 'string') return raw.data.text;

    // OpenAI-style choices
    if (raw.choices && Array.isArray(raw.choices) && raw.choices.length > 0) {
      const c = raw.choices[0];
      // Chat-style message
      if (c.message && typeof c.message.content === 'string') return c.message.content;
      // text field
      if (typeof c.text === 'string') return c.text;
      // sometimes message.content is array blocks
      if (c?.message?.content && Array.isArray(c.message.content)) {
        for (const block of c.message.content) {
          if (typeof block === 'string') return block;
          if (block?.text && typeof block.text === 'string') return block.text;
        }
      }
    }

    // Some endpoints return output as array of blocks
    if (Array.isArray(raw.output) && raw.output.length) {
      // join textual blocks
      try {
        return raw.output.map(o => (typeof o === 'string' ? o : (o?.text || ''))).join('\n');
      } catch (e) {
        // fallback
      }
    }

    // Fallback: stringify some part of raw (limited)
    try {
      return JSON.stringify(raw).slice(0, 20000);
    } catch (e) {
      return '';
    }
  }

  if (LLM_ENDPOINT) {
    try {
      const payload = {
        model: chosenModel,
        prompt,
        max_tokens,
        temperature,
        stream: false
      };

      const resp = await axios.post(LLM_ENDPOINT, payload, {
        timeout: 120000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      const raw = resp.data;
      const possible = extractPossibleTextFromRaw(raw);

      // parse & clean the textual content (extract response body, strip fences, pull SQL)
      const { cleanedText, sql } = parseLLMResponseText(possible, raw);

      const usage = raw?.usage || null;
      return { text: cleanedText || possible || '', raw, usage, sql: sql || null };
    } catch (err) {
      const msg = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 1000) : err.message;
      const e = new Error(`LLM endpoint error: ${msg}`);
      e.cause = err;
      throw e;
    }
  }

  // Fallback to OpenAI Chat Completions
  if (!OPENAI_KEY) throw new Error('No LLM endpoint configured (set LLM_ENDPOINT or OPENAI_API_KEY)');

  try {
    const body = {
      model: normalizeModel(model),
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
    const possible = extractPossibleTextFromRaw(raw);
    const { cleanedText, sql } = parseLLMResponseText(possible, raw);

    const usage = raw?.usage || null;
    return { text: cleanedText || possible || '', raw, usage, sql: sql || null };
  } catch (err) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 1000) : err.message;
    const e = new Error(`OpenAI request error: ${msg}`);
    e.cause = err;
    throw e;
  }
}

module.exports = { queryLLM };
