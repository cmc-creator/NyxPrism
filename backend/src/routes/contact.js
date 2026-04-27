import express from 'express';
import { Resend } from 'resend';
import rateLimit from 'express-rate-limit';
import pool from '../db/index.js';

const router = express.Router();

function getResend() {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured.');
  return new Resend(process.env.RESEND_API_KEY);
}

// 5 submissions per IP per 15 minutes
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many messages from this IP, please try again in 15 minutes.' },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/', limiter, async (req, res) => {
  const { firstName, lastName, email, subject, message } = req.body ?? {};

  if (!firstName || !lastName || !email || !subject || !message) {
    return res.status(400).json({ error: 'All fields are required.' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }
  if (message.trim().length < 20) {
    return res.status(400).json({ error: 'Message must be at least 20 characters.' });
  }

  // Sanitise lengths to prevent DB / email abuse
  const safe = {
    firstName: firstName.slice(0, 100),
    lastName:  lastName.slice(0, 100),
    email:     email.slice(0, 254),
    subject:   subject.slice(0, 100),
    message:   message.slice(0, 5000),
  };

  try {
    await pool.query(
      `INSERT INTO contact_messages (first_name, last_name, email, subject, message)
       VALUES ($1, $2, $3, $4, $5)`,
      [safe.firstName, safe.lastName, safe.email, safe.subject, safe.message],
    );

    await getResend().emails.send({
      from:    'NyxPrism Contact <noreply@nyxprism.com>',
      to:      process.env.CONTACT_EMAIL,
      replyTo: safe.email,
      subject: `[NyxPrism] ${safe.subject} — ${safe.firstName} ${safe.lastName}`,
      html: `
        <p><strong>From:</strong> ${safe.firstName} ${safe.lastName} &lt;${safe.email}&gt;</p>
        <p><strong>Subject:</strong> ${safe.subject}</p>
        <hr />
        <p style="white-space:pre-wrap;">${safe.message}</p>
      `,
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Contact route error:', err);
    res.status(500).json({ error: 'Failed to deliver message. Please email info@nyxprism.com directly.' });
  }
});

export default router;
