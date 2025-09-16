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
  // remove nulls, trim, collapse whitespace and cap length
  return s.replace(/\u0000/g, '').trim().replace(/\s+/g, ' ').slice(0, 4000);
}

// escape triple backticks so a user can't prematurely break the assistant's output format
function escapeBackticks(s) {
  return s.replace(/```/g, '`' + '``'); // neutralize triple backticks inside user input
}

function looksLikeSQL(s) {
  if (!s) return false;
  const sqlStarts = /^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/i;
  return sqlStarts.test(s) || /;\s*$/.test(s) || /\bJOIN\b/i.test(s);
}

function looksLikeMongo(s) {
  if (!s) return false;
  // simple heuristics for mongo shell / driver usage
  return /db\.\w+\.(find|aggregate|insert|update|remove)\s*\(/i.test(s) || /collection\(['"`]\w+['"`]\)/i.test(s);
}

/**
 * Return a string prompt to send to the LLM which includes:
 * - system-like guideline on how to format output
 * - directive to either explain an input query or generate a query + explanation
 */
function buildGuidedPrompt(userPrompt, isUserQuery = false, queryType = 'sql_or_mongo') {
  // keep instructions explicit and prescriptive
  const instructionHeader = [
    "You are an expert assistant for generating and explaining database queries (SQL and MongoDB).",
    "Always follow this exact output pattern:",
    "1) First line must start with: Here's the query",
    "2) Immediately after that, include the query in fenced code block(s). Use ```sql for SQL and ```query or ```mongodb for MongoDB, e.g.:",
    "   ```sql",
    "   SELECT ...;",
    "   ```",
    "   or",
    "   ```mongodb",
    "   db.users.find({ ... })",
    "   ```",
    "3) After the fenced block(s), provide a clear explanation of what the query does, what tables/collections/fields it touches, any assumptions, and any potential issues (indexes, performance, security) if applicable.",
    "",
    "If the user already provided a query (SQL or MongoDB), DO NOT generate a different query — explain the provided query using the same format: show the query (fenced) and then explanation.",
    "",
    "Keep answers concise, readable, and developer-friendly.",
    ""
  ].join("\n");

  const sanitized = escapeBackticks(userPrompt);

  if (isUserQuery) {
    // ask the model to explain the exact query given by the user
    return `${instructionHeader}\n\nUser-supplied query (explain this as-is):\n\n${sanitized}\n\nRespond now.`;
  } else {
    // user asked in natural language: create a query and then explain it
    return `${instructionHeader}\n\nUser request (generate an appropriate ${queryType} query from this request, then show the query and explain):\n\n${sanitized}\n\nRespond now.`;
  }
}

/**
 * Try to enforce the requested output format if the model violates it.
 * - If the model already used a fenced block (```), return as-is.
 * - Otherwise, attempt to find a SQL/Mongo snippet in the response and wrap it accordingly
 * - If the user-supplied prompt was itself a query and model response is explanatory text, wrap the original query
 */
function enforceOutputFormat(llmText, originalPrompt, originalWasQuery) {
  try {
    if (!llmText) llmText = '';

    // If model already returned with fences, trust it.
    if (/```/.test(llmText)) return llmText;

    // Attempt to extract SQL-like snippet ending with semicolon (simple heuristic)
    const sqlMatch = llmText.match(/((?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)[\s\S]{0,2000}?;)/i);
    if (sqlMatch) {
      const querySnippet = sqlMatch[1].trim();
      const before = llmText.slice(0, sqlMatch.index).trim();
      const after = llmText.slice(sqlMatch.index + querySnippet.length).trim();
      const explanation = (after || before || 'No additional explanation provided.').trim();
      return `Here's the query\n\n\`\`\`sql\n${querySnippet}\n\`\`\`\n\n${explanation}`;
    }

    // Attempt to detect Mongo-like snippet
    const mongoMatch = llmText.match(/(db\.[\s\S]{1,2000}?(\)|;))/i);
    if (mongoMatch) {
      const querySnippet = mongoMatch[1].trim().replace(/;$/, '');
      const before = llmText.slice(0, mongoMatch.index).trim();
      const after = llmText.slice(mongoMatch.index + querySnippet.length).trim();
      const explanation = (after || before || 'No additional explanation provided.').trim();
      return `Here's the query\n\n\`\`\`mongodb\n${querySnippet}\n\`\`\`\n\n${explanation}`;
    }

    // If the original prompt was itself the query, prefer showing that query and the model explanation.
    if (originalWasQuery) {
      return `Here's the query\n\n\`\`\`${looksLikeMongo(originalPrompt) ? 'mongodb' : 'sql'}\n${originalPrompt.trim()}\n\`\`\`\n\nExplanation:\n${llmText.trim() || 'No explanation provided.'}`;
    }

    // Fallback: wrap the whole model reply as the explanation and leave a placeholder for the query.
    return `Here's the query\n\n\`\`\`query\n-- Could not reliably extract a single query from the assistant's output.\n-- Assistant's raw output is provided as the explanation below.\n\`\`\`\n\nExplanation:\n${llmText.trim() || 'No explanation provided.'}`;
  } catch (e) {
    // if anything goes wrong, return a safe fallback
    return `Here's the query\n\n\`\`\`query\n-- (formatting fallback) --\n\`\`\`\n\nExplanation:\nCould not format assistant output due to an internal parsing error.`;
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
    const cleaned = sanitizePrompt(rawPrompt);
    if (!cleaned) return res.status(400).json({ error: 'Prompt is required' });

    // Determine whether the user's prompt already *is* a query (SQL or Mongo)
    const isSQLQuery = looksLikeSQL(cleaned);
    const isMongoQuery = looksLikeMongo(cleaned);
    const originalWasQuery = isSQLQuery || isMongoQuery;

    // Ensure chat exists (only that it belongs to the user)
    let chat = null;
    if (chatId) {
      chat = await Chat.findOne({ _id: chatId, user: userId });
      if (!chat) return res.status(404).json({ error: 'Chat not found' });
    } else {
      chat = await Chat.create({ user: userId, title: cleaned.slice(0, 50) || 'New Chat' });
    }

    // Create pending Query record so frontend can reference it immediately if needed
    saved = await Query.create({
      user: userId,
      chat: chat._id,
      prompt: cleaned,
      model: model || undefined,
      status: 'pending',
      createdAt: new Date()
    });

    // Build the guided prompt for the LLM
    const guidedPrompt = buildGuidedPrompt(cleaned, originalWasQuery, (isMongoQuery ? 'mongodb' : 'sql_or_mongo'));

    // Call LLM (synchronous)
    const llmResult = await queryLLM({
      prompt: guidedPrompt,
      model,
      max_tokens: max_tokens || 512,
      temperature: typeof temperature === 'number' ? temperature : 0.2
    });

    // llmResult expected shape: { text, raw, usage, sql? }
    const { text = '', raw = null, usage = null } = llmResult || {};

    // Ensure `text` is a string (safety) and then enforce the output format
    const answerStringRaw = (typeof text === 'string') ? text : String(text || '');
    const answerString = enforceOutputFormat(answerStringRaw, cleaned, originalWasQuery);

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
