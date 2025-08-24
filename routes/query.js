const express = require('express');
const QueryModel = require('../models/Query');
const { generateResponse } = require('../utils/llm');
const auth = require('../middleware/auth');

const router = express.Router();

/**
 * POST /query
 * body: { query: string }
 * Authenticated route (optional). For MVP, you can allow public.
 */
router.post('/', auth, async (req, res) => {
  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: 'query required' });

    // Choose model logic (very basic)
    const modelUsed = (query.length > 200) ? 'qwen-7b' : 'mistral-3.5';

    // Call LLM wrapper
    const prompt = `User Query: ${query}\n\nReturn a concise JSON result.`;
    const llmResult = await generateResponse(prompt, { model: modelUsed });

    // Save
    const q = await QueryModel.create({
      userId: req.user ? req.user._id : null,
      queryText: query,
      responseText: llmResult,
      modelUsed
    });

    res.json({ success: true, result: llmResult, queryId: q._id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
