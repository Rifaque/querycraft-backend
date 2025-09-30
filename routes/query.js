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
  legacyHeaders: false,
  // avoid X-Forwarded-For validation problems by using socket remoteAddress
  keyGenerator: (req /*, res */) => {
    return req.socket?.remoteAddress || req.ip || 'unknown';
  }
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
 * - strong instruction to output JSON with { query, explanation }
 * - examples (few-shot) to help models follow the format
 */
function buildGuidedPrompt(userPrompt, isUserQuery = false, queryType = 'sql_or_mongo') {
  const instructionHeader = [
    "You are an expert assistant for generating and explaining database queries (SQL and MongoDB).",
    "IMPORTANT: Respond ONLY with a valid JSON object with exactly two string fields: {\"query\": \"...\", \"explanation\": \"...\"}.",
    "- The \"query\" field must contain the query text only. Wrap the query inside triple backticks with the appropriate language tag (```sql or ```mongodb or ```query).",
    "- The \"explanation\" field must be a clear, concise explanation of what the query does, assumptions, affected tables/collections, and any performance/security notes.",
    "CRITICAL RULES (do not break):",
    "1) Produce the **minimal** query that satisfies the user's explicit request. Do NOT add extra WHERE clauses, JOINs, GROUP BYs, ORDER BYs, LIMITs, date filters, or other conditions unless the user explicitly asked for them.",
    "2) If the user's request is ambiguous, DO NOT change the query to add inferred filters. Instead, keep the query minimal and list any inferred assumptions or suggested optional filters in the explanation.",
    "3) If the user provided a full query, EXPLAIN THAT QUERY as-is (do not edit or 'improve' it in the query field).",
    "4) Do NOT include any extra text outside the JSON object. If you cannot produce a query, set \"query\" to an empty string and put the reason in \"explanation\".",
    ""
  ].join("\n");

  // Use a minimal generation example (teaches minimality)
  const exampleGenerate = [
    "Example (user asked to generate):",
    `User request: "Return all students who have not paid the fees"`,
    `Response JSON:`,
    `{"query":"\`\`\`sql\nSELECT * FROM students WHERE paid = 0;\n\`\`\`", "explanation":"Selects all rows from students where paid = 0. No extra filters added because the user requested all unpaid students. If you wanted a date filter (e.g. last 7 days), specify it explicitly."}`
  ].join("\n");

  // Explain example when user supplies a query to be explained
  const exampleExplain = [
    "Example (user provided a query to explain):",
    `User query: "SELECT id, name FROM users WHERE active = 1;"`,
    `Response JSON:`,
    `{"query":"\`\`\`sql\nSELECT id, name FROM users WHERE active = 1;\n\`\`\`", "explanation":"Selects id and name columns from users where active = 1. Ensure an index on 'active' if table is large. No user-supplied parameters."}`
  ].join("\n");

  const sanitized = escapeBackticks(userPrompt);

  if (isUserQuery) {
    return `${instructionHeader}\n\nUser-supplied query (explain this as-is):\n\n${sanitized}\n\n${exampleExplain}\n\nRespond now with JSON only.`;
  } else {
    return `${instructionHeader}\n\nUser request (generate an appropriate ${queryType} query from this request, then show the query and explain):\n\n${sanitized}\n\n${exampleGenerate}\n\nRespond now with JSON only.`;
  }
}


/**
 * Try to enforce the requested output format:
 * 1) If the model returned JSON with {query, explanation}, use that.
 * 2) Otherwise fallback to old heuristics (fenced code, SQL/Mongo detection).
 */
function enforceOutputFormat(llmText, originalPrompt, originalWasQuery) {
  try {
    if (!llmText) llmText = '';

    // 1) Try to parse JSON first (robust method)
    try {
      // some models include backticks or surrounding text - attempt to extract first JSON substring
      const jsonMatch = llmText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const maybeJson = jsonMatch[0];
        const parsed = JSON.parse(maybeJson);
        if (typeof parsed === 'object' && parsed !== null && 'query' in parsed && 'explanation' in parsed) {
          // ensure query and explanation are strings
          const q = String(parsed.query || '').trim();
          const e = String(parsed.explanation || '').trim();
          // if query is empty, return a clear fallback explaining reason
          if (!q) {
            return `Here's the query\n\n\`\`\`query\n-- No query generated by the assistant.\n\`\`\`\n\nExplanation:\n${e || 'No explanation provided.'}`;
          }
          // return exactly the intended formatted output
          return `Here's the query\n\n${q}\n\n${e}`;
        }
      }
    } catch (je) {
      // JSON parse failed - continue to heuristics
      // (console.debug kept below)
    }

    // 2) If model already returned with fences, trust it.
    if (/```/.test(llmText)) return llmText;

    // 3) Attempt to extract SQL-like snippet ending with semicolon (heuristic)
    const sqlMatch = llmText.match(/((?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)[\s\S]{0,2000}?;)/i);
    if (sqlMatch) {
      const querySnippet = sqlMatch[1].trim();
      const before = llmText.slice(0, sqlMatch.index).trim();
      const after = llmText.slice(sqlMatch.index + querySnippet.length).trim();
      const explanation = (after || before || 'No additional explanation provided.').trim();
      return `Here's the query\n\n\`\`\`sql\n${querySnippet}\n\`\`\`\n\n${explanation}`;
    }

    // 4) Attempt to detect Mongo-like snippet
    const mongoMatch = llmText.match(/(db\.[\s\S]{1,2000}?(\)|;))/i);
    if (mongoMatch) {
      const querySnippet = mongoMatch[1].trim().replace(/;$/, '');
      const before = llmText.slice(0, mongoMatch.index).trim();
      const after = llmText.slice(mongoMatch.index + querySnippet.length).trim();
      const explanation = (after || before || 'No additional explanation provided.').trim();
      return `Here's the query\n\n\`\`\`mongodb\n${querySnippet}\n\`\`\`\n\n${explanation}`;
    }

    // 5) If the original prompt was itself the query, prefer showing that query and the model explanation.
    if (originalWasQuery) {
      return `Here's the query\n\n\`\`\`${looksLikeMongo(originalPrompt) ? 'mongodb' : 'sql'}\n${originalPrompt.trim()}\n\`\`\`\n\nExplanation:\n${llmText.trim() || 'No explanation provided.'}`;
    }

    // 6) Fallback: wrap the whole model reply as the explanation and leave a placeholder for the query.
    return `Here's the query\n\n\`\`\`query\n-- Could not reliably extract a single query from the assistant's output.\n-- Assistant's raw output is provided as the explanation below.\n\`\`\`\n\nExplanation:\n${llmText.trim() || 'No explanation provided.'}`;
  } catch (e) {
    // if anything goes wrong, return a safe fallback
    return `Here's the query\n\n\`\`\`query\n-- (formatting fallback) --\n\`\`\`\n\nExplanation:\nCould not format assistant output due to an internal parsing error.`;
  }
}

/**
 * Helper: call LLM with retry-on-failure to try to get JSON {query,explanation}
 */
async function callLlmWithRetries(guidedPrompt, model, max_tokens, temperature, originalPrompt, originalWasQuery) {
  // First try: use provided temperature
  const attempt = async (opts) => {
    const llmResult = await queryLLM(opts);
    const text = (llmResult && typeof llmResult.text === 'string') ? llmResult.text : String(llmResult?.text || '');
    return { llmResult, text };
  };

  // Attempt 1
  let { llmResult, text } = await attempt({ prompt: guidedPrompt, model, max_tokens, temperature });
  // quick check: does it include JSON with query/explanation or typical fences?
  const formatted = enforceOutputFormat(text, originalPrompt, originalWasQuery);
  if (!/Could not reliably extract a single query/.test(formatted) && (formatted.includes("Here's the query") || /```/.test(formatted))) {
    return { llmResult, text, formatted };
  }

  // Attempt 2 (stricter): force determinism and explicit JSON-only instruction
  const strongerPrompt = guidedPrompt + "\n\nSECOND ATTEMPT: If you did not output the JSON object earlier, output only the JSON object now. Do NOT ask clarifying questions. Use empty \"query\" if you cannot generate one.";
  ({ llmResult, text } = await attempt({ prompt: strongerPrompt, model, max_tokens, temperature: 0.0 }));
  const formatted2 = enforceOutputFormat(text, originalPrompt, originalWasQuery);
  return { llmResult, text, formatted: formatted2 };
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

    // Call LLM with retry behavior
    const llmCall = await callLlmWithRetries(guidedPrompt, model, max_tokens || 512, typeof temperature === 'number' ? temperature : 0.2, cleaned, originalWasQuery);

    // llmResult expected shape: { text, raw, usage, sql? }
    const { llmResult } = llmCall || {};
    const text = llmCall?.text || '';
    const raw = llmResult?.raw ?? llmResult ?? null;
    const usage = llmResult?.usage ?? null;

    // Ensure `text` is a string (safety) and then enforce the output format (we already did, but do again)
    const answerStringRaw = (typeof text === 'string') ? text : String(text || '');
    const answerString = llmCall?.formatted || enforceOutputFormat(answerStringRaw, cleaned, originalWasQuery);

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

    // helpful debug: also log the raw text returned by the LLM (trimmed) to server logs
    console.debug('LLM raw text (trim):', (answerStringRaw || '').slice(0, 1000));

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

// paste/replace the existing demo route with this block
router.post('/demo', limiter, async (req, res) => {
  try {
    const { prompt: rawPrompt, model, max_tokens, temperature } = req.body || {};
    const cleaned = sanitizePrompt(rawPrompt);
    if (!cleaned) return res.status(400).json({ error: 'Prompt is required' });

    const isSQLQuery = looksLikeSQL(cleaned);
    const isMongoQuery = looksLikeMongo(cleaned);
    const originalWasQuery = isSQLQuery || isMongoQuery;

    // default demo model -> llama3.2:1b (will be normalized in queryLLM)
    const modelParam = model || 'llama3.2:1b';

    // Build guided prompt for demo
    const guidedPrompt = buildGuidedPrompt(
      cleaned,
      originalWasQuery,
      isMongoQuery ? 'mongodb' : 'sql_or_mongo'
    );

    // Call LLM (pass modelParam)
    const llmCall = await callLlmWithRetries(
      guidedPrompt,
      modelParam,
      max_tokens || 256,
      typeof temperature === 'number' ? temperature : 0.2,
      cleaned,
      originalWasQuery
    );

    const answerStringRaw = String(llmCall?.text || '');
    const answerString = llmCall?.formatted || enforceOutputFormat(answerStringRaw, cleaned, originalWasQuery);

    console.debug('DEMO LLM raw text (trim):', answerStringRaw.slice(0, 500));

    // Helper: extract only the query portion from whatever the LLM returned.
    function extractQueryOnly(formattedOrRaw, rawText) {
      const candidate = String(formattedOrRaw || rawText || '').trim();
      if (!candidate) return '';

      // 1) If the candidate itself is JSON or contains JSON, try to parse
      try {
        // try direct parse
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          if (parsed.query) return String(parsed.query).trim();
          if (parsed.response && typeof parsed.response === 'string') {
            // nested string that might be JSON
            try {
              const nested = JSON.parse(parsed.response);
              if (nested?.query) return String(nested.query).trim();
            } catch {}
          }
        }
      } catch (e) {
        // not direct JSON, try to find a JSON substring
        const jsonMatch = candidate.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            const parsed2 = JSON.parse(jsonMatch[0]);
            if (parsed2?.query) return String(parsed2.query).trim();
          } catch {}
        }
      }

      // 2) Look for fenced code block (```sql / ```mongodb / ```query)
      const fence = candidate.match(/```(?:sql|mongodb|query)?\n([\s\S]*?)\n```/i);
      if (fence) return fence[1].trim();

      // 3) Attempt to extract SQL snippet that ends with semicolon
      const sqlMatch = candidate.match(/((?:SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)[\s\S]{0,2000}?;)/i);
      if (sqlMatch) return sqlMatch[1].trim();

      // 4) Attempt to extract simple mongo shell command (db.collection...)
      const mongoMatch = candidate.match(/(db\.[\s\S]{1,2000}?(\)|;))/i);
      if (mongoMatch) return mongoMatch[1].trim().replace(/;$/, '');

      // 5) fallback: return the whole candidate (trimmed)
      return candidate;
    }

    const onlyQuery = extractQueryOnly(llmCall?.formatted || answerString, answerStringRaw);

    return res.json({
      status: 'ok',
      response: onlyQuery
    });
  } catch (err) {
    console.error('Demo query error', err);
    return res.status(500).json({
      error: 'LLM demo request failed',
      message: err.message || 'Unknown error'
    });
  }
});

module.exports = router;
