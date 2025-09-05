// routes/query.js
const express = require('express');
const router = express.Router();
const { queryLLM } = require('../utils/llm');
const auth = require('../middleware/auth');
const Query = require('../models/Query');
const Chat = require('../models/Chat');
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});

function sanitizePrompt(s) {
  if (!s) return '';
  return s.replace(/\u0000/g, '').trim().replace(/\s+/g, ' ').slice(0, 4000);
}

// (kept in case you want to use it later; not used in the minimal response)
function sanitizeRawPreview(obj, opts = {}) {
  const maxString = opts.maxString || 1000;
  const maxArray = opts.maxArray || 10;
  const maxDepth = opts.maxDepth || 3;

  function truncStr(s) {
    if (typeof s !== 'string') return s;
    if (s.length <= maxString) return s;
    return s.slice(0, maxString) + `...<truncated ${s.length - maxString} chars>`;
  }

  function helper(value, depth = 0) {
    if (depth > maxDepth) return '[Truncated: maxDepth]';
    if (value == null) return value;
    if (typeof value === 'string') return truncStr(value);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) {
      const arr = value.slice(0, maxArray).map(v => helper(v, depth + 1));
      if (value.length > maxArray) arr.push(`[+${value.length - maxArray} items truncated]`);
      return arr;
    }
    if (typeof value === 'object') {
      const out = {};
      const keys = Object.keys(value).slice(0, 30);
      for (const k of keys) {
        out[k] = helper(value[k], depth + 1);
      }
      if (Object.keys(value).length > keys.length) out._note = `${Object.keys(value).length - keys.length} keys truncated`;
      return out;
    }
    return String(value);
  }

  try {
    return helper(obj);
  } catch (e) {
    return '[Could not sanitize raw response]';
  }
}

/**
 * POST /api/query
 * Body: { chatId, prompt, model?, max_tokens?, temperature? }
 *
 * Minimal Response (200):
 * {
 *   queryId,
 *   chatId,
 *   model,
 *   status,
 *   createdAt,
 *   updatedAt,
 *   response  // STRING (the generated answer only)
 * }
 */
router.post('/', limiter, auth, async (req, res) => {
  let saved; // keep in outer scope so catch can access it
  try {
    const userId = req.userId;
    const { chatId, prompt: rawPrompt, model, max_tokens, temperature } = req.body || {};
    const prompt = sanitizePrompt(rawPrompt);

    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // Ensure chat exists (only that it belongs to the user)
    let chat = null;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, user: userId });
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
    } else {
      chat = await Chat.create({ user: userId, title: prompt.slice(0, 50) || 'New Chat' });
    }

    // Create pending Query record so frontend can reference it immediately if needed
    saved = await Query.create({
      user: userId,
      chat: chat._id,
      prompt,
      model: model || undefined,
      status: 'pending',
      createdAt: new Date()
    });

    // Call LLM (synchronous)
    const llmResult = await queryLLM({
      prompt,
      model,
      max_tokens: max_tokens || 512,
      temperature: typeof temperature === 'number' ? temperature : 0.2
    });

    // llmResult expected shape: { text, raw, usage, sql? }
    const { text = '', raw = null, usage = null } = llmResult || {};

    // Ensure `text` is a string (safety) and store the actual generated answer as plain string
    const answerString = (typeof text === 'string') ? text : String(text || '');

    // Save result to DB: response is the plain string, raw kept for debugging
    saved.response = answerString;
    saved.raw = raw;        // full raw stored in DB if you want to inspect later
    saved.usage = usage;
    saved.model = model || saved.model;
    saved.status = 'done';
    await saved.save();

    // Update chat's last updated time
    chat.updatedAt = new Date();
    await chat.save();

    // Build minimal frontend payload
    const updatedAt = new Date(); // use a concrete updatedAt for response
    const payload = {
      queryId: saved._id,
      chatId: chat._id,
      model: saved.model || null,
      status: saved.status,
      createdAt: saved.createdAt,
      updatedAt: updatedAt,
      response: answerString // <-- plain string only
    };

    return res.json(payload);
  } catch (err) {
    console.error('Query error', err);

    // attempt to mark the saved query as failed if it exists
    try {
      if (saved && saved._id) {
        saved.status = 'failed';
        saved.response = ''; // no response
        saved.raw = (err?.response?.data) ? err.response.data : { message: err.message };
        saved.errorMessage = String(err.message).slice(0, 1000);
        await saved.save();
      }
    } catch (saveErr) {
      console.error('Failed to update saved query on error:', saveErr);
    }

    return res.status(500).json({
      error: 'LLM request failed',
      message: err.message || 'Unknown error'
    });
  }
});

module.exports = router;
