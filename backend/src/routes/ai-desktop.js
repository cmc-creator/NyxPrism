import { Router } from 'express';
import { requireActivePlan, requireAuth } from '../middleware/auth.js';
import { aiDailyQuota, askClaude, HELP_MODEL } from '../ai.js';

const router = Router();

const MAX_SYSTEM_CHARS = 4000;
const MAX_INPUT_CHARS = 40_000;
const MAX_OUTPUT_TOKENS = 1024;

// POST /api/ai/desktop  { system, input, maxTokens }
// AI for the NyxPrism desktop app (boundary detection, naming, summaries,
// classification, key-info extraction) — included with Professional.
router.post('/', requireAuth, requireActivePlan, aiDailyQuota, async (req, res) => {
  const { system, input } = req.body ?? {};
  if (typeof system !== 'string' || !system.trim() || system.length > MAX_SYSTEM_CHARS) {
    return res.status(400).json({ error: `system must be 1–${MAX_SYSTEM_CHARS} characters.` });
  }
  if (typeof input !== 'string' || !input.trim()) {
    return res.status(400).json({ error: 'input is required.' });
  }
  const maxTokens = Math.max(16, Math.min(MAX_OUTPUT_TOKENS, parseInt(req.body?.maxTokens, 10) || 256));
  try {
    const reply = await askClaude({
      model: HELP_MODEL,
      system: `You are the document assistant inside the NyxPrism desktop PDF app. Follow the task instructions exactly and reply with only the requested output.\n\n${system}`,
      messages: [{ role: 'user', content: input.slice(0, MAX_INPUT_CHARS) }],
      maxTokens,
    });
    res.json({ reply });
  } catch (err) {
    console.error('AI desktop error:', err.message);
    res.status(502).json({ error: err.userFacing ? err.message : 'AI service unavailable. Please try again.' });
  }
});

export default router;
