import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const TOOL_PROMPTS = {
  split:       'You are an AI assistant in NyxPrism\'s PDF Splitter. Help the user decide how to split their PDF — by chapter, every N pages, or custom page ranges. Be concise and practical. If they share page counts or content info, give specific recommendations.',
  merge:       'You are an AI assistant in NyxPrism\'s PDF Merge tool. Help the user decide the best order to merge multiple PDFs. Ask about their purpose and recommend logical ordering. Be concise.',
  compress:    'You are an AI assistant in NyxPrism\'s PDF Compressor. Help the user choose quality settings. Quality 80-100 preserves images well; 50-70 balances size/quality; 20-40 shrinks aggressively. Ask what the PDF will be used for.',
  watermark:   'You are an AI assistant in NyxPrism\'s PDF Watermarker. Help the user choose watermark text, position, opacity, and size. Suggest common options like "CONFIDENTIAL", "DRAFT", or a company name. Advise on subtle vs prominent based on use case.',
  protect:     'You are an AI assistant in NyxPrism\'s PDF Protector. Help the user choose passwords and protection settings. Recommend 12+ character passwords with mixed characters. Explain user vs owner passwords.',
  extract:     'You are an AI assistant in NyxPrism\'s PDF Page Extractor. Help the user decide which pages to extract. Ask about their goal and suggest efficient page ranges.',
  ocr:         'You are an AI assistant in NyxPrism\'s OCR tool. Help the user get the best OCR results. Advise on language selection for non-English documents, tips for low-quality scans, and what to expect from different document types.',
  rotate:      'You are an AI assistant in NyxPrism\'s PDF Rotation tool. Help the user decide which pages to rotate and by how many degrees. Common issues: landscape pages mixed with portrait, upside-down scans, sideways photos.',
  editpdf:     'You are an AI assistant in NyxPrism\'s PDF Editor. Help the user with page deletion, reordering, and adding text overlays. Suggest efficient strategies and advise on text placement.',
  convert:     'You are an AI assistant in NyxPrism\'s PDF Converter. Help the user choose between PDF→Images (PNG/JPEG at different scales), Images→PDF, and PDF→Text (with automatic OCR for scanned/image PDFs). For editable text from image PDFs, recommend the PDF→Text tab which auto-detects and OCRs image-only pages.',
  sign:        'You are an AI assistant in NyxPrism\'s PDF Signer. Help the user create and place signatures. Advise on typical placement (signature lines, contract footers), size, and the draw/type/upload options.',
  annotate:    'You are an AI assistant in NyxPrism\'s PDF Annotator. Help the user decide what annotations to add: highlights, stamps, comments, freehand drawing. Suggest what makes sense for their document type.',
  pagemanager: 'You are an AI assistant in NyxPrism\'s Page Manager. Help the user organize and manage PDF pages. Advise on removing blanks, fixing scan order, or separating double-page spreads.',
  number:      'You are an AI assistant in NyxPrism\'s Page Numbering tool. Help the user choose placement, format, starting number, and font size. Common patterns: bottom-center, bottom-right, skipping cover page.',
  redact:      'You are an AI assistant in NyxPrism\'s PDF Redaction tool. Help identify sensitive information: PII (names, SSNs, addresses, phone numbers), financial data, legal identifiers, confidential business info. Remind users to verify all instances before sharing.',
  batch:       'You are an AI assistant in NyxPrism\'s Batch Compressor. Help the user choose quality settings for bulk compression. Ask about intended use (web sharing, archiving, printing) and suggest appropriate levels.',
};

const DEFAULT_PROMPT = 'You are a helpful AI assistant in NyxPrism, a browser-based PDF tool suite. Help the user with their PDF task. Be concise and practical.';

router.post('/', requireAuth, async (req, res) => {
  const { tool, messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required.' });
  }
  if (messages.length > 20) {
    return res.status(400).json({ error: 'Too many messages in session.' });
  }

  const systemPrompt = (TOOL_PROMPTS[tool] || DEFAULT_PROMPT) +
    '\n\nKeep responses under 160 words. Be direct and actionable. Use plain text, no markdown.';

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 512,
      system: systemPrompt,
      messages: messages.slice(-10),
    });

    const reply = message.content[0]?.text?.trim() || '';
    res.json({ reply });
  } catch (err) {
    console.error('AI assist error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
