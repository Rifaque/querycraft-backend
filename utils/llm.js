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
 * Otherwise falls back to OpenAI Chat Completions (requires OPENAI_API_KEY).
 *
 * Returns { text, raw, usage, sql? }
 */
async function queryLLM({ prompt, model = null, max_tokens = 512, temperature = 0.2 }) {
  if (!prompt || !prompt.trim()) throw new Error('Empty prompt');

  const chosenModel = normalizeModel(model);

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
      let text = '';

      // Flexible parsing for different LLM response shapes (extract raw textual part)
      if (!raw && raw !== '') {
        text = '';
      } else if (typeof raw === 'string') {
        text = raw;
      } else if (typeof raw.output === 'string') {
        text = raw.output;
      } else if (typeof raw.result === 'string') {
        text = raw.result;
      } else if (raw?.choices && Array.isArray(raw.choices) && raw.choices.length > 0) {
        const c = raw.choices[0];
        if (c?.message?.content && typeof c.message.content === 'string') text = c.message.content;
        else if (c?.text && typeof c.text === 'string') text = c.text;
        else if (c?.message?.content && Array.isArray(c.message.content)) {
          for (const block of c.message.content) {
            if (block?.type === 'output_text' && typeof block.text === 'string') {
              text = block.text;
              break;
            }
            if (block?.text && typeof block.text === 'string') {
              text = block.text;
              break;
            }
          }
        }
      } else if (Array.isArray(raw?.output)) {
        text = raw.output.join('\n');
      } else if (typeof raw === 'object') {
        if (raw?.response && typeof raw.response === 'string') {
          text = raw.response;
        } else if (raw?.message?.content) {
          text = typeof raw.message.content === 'string'
            ? raw.message.content
            : JSON.stringify(raw.message.content).slice(0, 2000);
        } else {
          text = JSON.stringify(raw).slice(0, 2000);
        }
      } else {
        text = String(raw).slice(0, 2000);
      }

      // Now parse & clean the textual content (extract response body, strip fences, pull SQL)
      const { cleanedText, sql } = parseLLMResponseText(text, raw);

      const usage = raw?.usage || null;
      return { text: cleanedText || text || '', raw, usage, sql: sql || null };
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
    const extracted = (raw?.choices && raw.choices[0]?.message?.content) || (raw?.choices && raw.choices[0]?.text) || '';
    // Clean / parse OpenAI text similarly
    const { cleanedText, sql } = parseLLMResponseText(extracted, raw);

    const usage = raw?.usage || null;
    return { text: cleanedText || extracted || '', raw, usage, sql: sql || null };
  } catch (err) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data).slice(0, 1000) : err.message;
    const e = new Error(`OpenAI request error: ${msg}`);
    e.cause = err;
    throw e;
  }
}

module.exports = { queryLLM };
