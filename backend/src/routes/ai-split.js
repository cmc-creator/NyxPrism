import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// Rate limit: max 1500 chars of PDF text per request to keep costs sane
const MAX_TEXT_CHARS = 80_000;

router.post('/', requireAuth, async (req, res) => {
  const { pdfText, criteria, filename } = req.body;

  if (!pdfText || typeof pdfText !== 'string') {
    return res.status(400).json({ error: 'pdfText is required.' });
  }
  if (!criteria || typeof criteria !== 'string') {
    return res.status(400).json({ error: 'criteria is required.' });
  }

  const truncated = pdfText.slice(0, MAX_TEXT_CHARS);

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You are a PDF document analysis assistant. The user has a multi-page PDF and wants to split it intelligently.
You will receive the text content of the PDF (pages separated by "--- Page N ---" markers) and a split criteria.
Your job is to return a JSON array of split groups. Each group represents one output file.

Rules:
- Return ONLY valid JSON, no explanation, no markdown code fences.
- Each element: { "pages": [1, 2, 3], "filename": "suggested_name.pdf" }
- Pages are 1-based integers.
- Every page must appear in exactly one group.
- Filenames must be filesystem-safe (no special chars except underscores and hyphens), end in .pdf.
- Base filenames on the criteria value found (e.g. policy number, invoice number, customer name).
- If a page cannot be clearly assigned, put it with the previous group.
- Keep filenames concise but descriptive (max 60 chars).`;

  const userPrompt = `PDF filename: ${filename || 'document.pdf'}

Split criteria: "${criteria}"

PDF text content:
${truncated}

Return the JSON split plan now.`;

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: userPrompt }],
      system: systemPrompt,
    });

    const raw = message.content[0]?.text?.trim();
    if (!raw) return res.status(500).json({ error: 'Empty response from AI.' });

    // Strip any accidental markdown fences
    const jsonStr = raw.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
    const splits = JSON.parse(jsonStr);

    if (!Array.isArray(splits)) {
      return res.status(500).json({ error: 'AI returned unexpected format.' });
    }

    res.json({ splits });
  } catch (err) {
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: 'AI returned invalid JSON. Try again or simplify your criteria.' });
    }
    console.error('AI split error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
