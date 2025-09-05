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

/**
 * POST /api/query
 * Body: { chatId, prompt, model?, max_tokens?, temperature? }
 */
router.post('/', limiter, auth, async (req, res) => {
  try {
    const userId = req.userId;
    const { chatId, prompt: rawPrompt, model, max_tokens, temperature } = req.body || {};
    const prompt = sanitizePrompt(rawPrompt);

    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    // Ensure chat exists
    let chat = null;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, user: userId });
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
    } else {
      chat = await Chat.create({ user: userId, title: prompt.slice(0, 50) || 'New Chat' });
    }

    // Save pending query
    let saved = await Query.create({
      user: userId,
      chat: chat._id,
      prompt,
      model: model || 'default',
      status: 'pending',
      createdAt: new Date()
    });

    // Call LLM
    const { text, raw, usage } = await queryLLM({
      prompt,
      model,
      max_tokens: max_tokens || 512,
      temperature: typeof temperature === 'number' ? temperature : 0.2
    });

    // Save response
    saved.response = text;
    saved.raw = raw;
    saved.usage = usage;
    saved.status = 'done';
    await saved.save();

    // Update chat's last updated time
    chat.updatedAt = new Date();
    await chat.save();

    return res.json({ text, usage, raw, chatId: chat._id });
  } catch (err) {
    console.error('Query error', err);
    return res.status(500).json({ error: 'LLM request failed', message: err.message });
  }
});

/**
 * GET /api/query/:id
 * Returns a single query (if belongs to user)
 */
router.get('/:id', auth, async (req, res) => {
  try {
    const record = await Query.findById(req.params.id).lean().exec();
    if (!record) return res.status(404).json({ error: 'Not found' });
    if (String(record.user) !== String(req.userId)) return res.status(403).json({ error: 'Forbidden' });
    return res.json(record);
  } catch (err) {
    console.error('Get query error', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
