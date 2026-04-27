import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const MAX_TEXT_CHARS = 80_000;

router.post('/', requireAuth, async (req, res) => {
  const { pdfText, messages, filename, pageCount } = req.body;

  if (!pdfText || typeof pdfText !== 'string') {
    return res.status(400).json({ error: 'pdfText is required.' });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }

  const truncated = pdfText.slice(0, MAX_TEXT_CHARS);
  const pages = pageCount || '?';

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You are an AI assistant built into NyxPrism, a browser-based PDF tool. Your job is to help the user split their PDF intelligently through a friendly conversation.

The user uploaded: "${filename || 'document.pdf'}" (${pages} pages).

PDF text content (pages separated by "--- Page N ---" markers):
===
${truncated}
===

Conversation rules:
- Be concise and friendly.
- On the very first message, greet the user, mention the filename and page count, and ask how they'd like to split it. Give 2–3 short examples.
- Ask follow-up questions if the criteria are unclear (e.g. which pages belong to which section).
- Once you have enough information, produce the split plan inline using this exact format — no markdown fences, just the tag:
  <SPLIT_PLAN>[{"pages":[1,2],"filename":"part1.pdf"},...]</SPLIT_PLAN>
- After the tag, briefly explain the plan in plain language.
- Filename rules: filesystem-safe (alphanumeric, underscores, hyphens only), end in .pdf, max 60 chars, descriptive.
- Every page 1..${pages} must appear in exactly one group. Pages are 1-based integers.
- If the user wants to revise, update the plan by emitting a new <SPLIT_PLAN> tag.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });

    const raw = message.content[0]?.text?.trim() || '';

    // Extract plan if present
    let plan = null;
    const planMatch = raw.match(/<SPLIT_PLAN>([\s\S]*?)<\/SPLIT_PLAN>/);
    if (planMatch) {
      try {
        const parsed = JSON.parse(planMatch[1].trim());
        if (Array.isArray(parsed)) plan = parsed;
      } catch {
        // Plan tag present but malformed — let the conversation continue
      }
    }

    res.json({ reply: raw, plan });
  } catch (err) {
    console.error('AI split error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
