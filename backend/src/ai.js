import Anthropic from '@anthropic-ai/sdk';
import pool from './db/index.js';
import { isDeveloper } from './access.js';

// Quick in-tool help chats: short answers, so the fastest, cheapest model.
export const HELP_MODEL = 'claude-haiku-4-5';
// AI Smart Split reads a whole document and plans page groups.
export const SPLIT_MODEL = 'claude-sonnet-5';
// AI requests allowed per user per UTC day (owner/reviewer accounts are exempt).
const DAILY_AI_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 100;

let client;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured.');
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

/**
 * Express middleware: counts one AI request against the user's daily quota
 * and answers 429 once it is used up.
 */
export async function aiDailyQuota(req, res, next) {
  if (isDeveloper(req.user?.email)) return next();
  try {
    const { rows } = await pool.query(
      `INSERT INTO ai_usage (firebase_uid, day, requests) VALUES ($1, CURRENT_DATE, 1)
       ON CONFLICT (firebase_uid, day) DO UPDATE SET requests = ai_usage.requests + 1
       RETURNING requests`,
      [req.user.uid],
    );
    if (rows[0].requests > DAILY_AI_LIMIT) {
      return res.status(429).json({ error: `You've used today's ${DAILY_AI_LIMIT} AI requests. The limit resets at midnight UTC.` });
    }
    next();
  } catch (err) {
    console.error('AI quota error:', err.message);
    res.status(500).json({ error: 'Unable to check AI usage.' });
  }
}

/**
 * One Claude call. Returns the reply text, or throws with a user-facing message.
 * Replies are gathered from text blocks (adaptive-thinking models emit a
 * thinking block first). `effort` is skipped for Claude Haiku 4.5, which
 * does not accept it.
 */
export async function askClaude({ model, system, messages, maxTokens, effort }) {
  const params = { model, max_tokens: maxTokens, system, messages };
  if (effort && model !== 'claude-haiku-4-5') params.output_config = { effort };
  const response = await getClient().messages.create(params);
  if (response.stop_reason === 'refusal') {
    const err = new Error('The AI assistant declined this request. Try rephrasing it.');
    err.userFacing = true;
    throw err;
  }
  const text = response.content.filter(block => block.type === 'text').map(block => block.text).join('').trim();
  if (!text && response.stop_reason === 'max_tokens') {
    const err = new Error('The AI response was too long. Try a shorter question.');
    err.userFacing = true;
    throw err;
  }
  return text;
}
