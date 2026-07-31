const SYSTEM_PROMPT = `You are NyxPrism's helpful product assistant. Answer questions about NyxPrism's PDF tools, pricing, API, installation, dashboard, and privacy. Be concise, accurate, and friendly. Do not invent features, pricing, policies, or account information. For account-specific help, payments, or issues you cannot resolve, direct people to the NyxPrism contact page.`;

const MAX_MESSAGES = 12;
const MAX_MESSAGE_LENGTH = 1_500;

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .slice(-MAX_MESSAGES)
    .filter(({ role, content }) =>
      (role === 'user' || role === 'assistant') &&
      typeof content === 'string' &&
      content.trim().length > 0,
    )
    .map(({ role, content }) => ({
      role,
      content: content.trim().slice(0, MAX_MESSAGE_LENGTH),
    }));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const messages = sanitizeMessages(req.body?.messages);
  if (!messages.length || messages.at(-1).role !== 'user') {
    return res.status(400).json({ error: 'Send a user message to start the conversation.' });
  }

  const token = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'Chat is not configured yet. Please try again later.' });
  }

  try {
    const response = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'openai/gpt-5.4',
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        max_completion_tokens: 400,
      }),
    });

    if (!response.ok) {
      console.error('AI Gateway request failed:', response.status);
      return res.status(502).json({ error: 'The assistant is temporarily unavailable. Please try again.' });
    }

    const payload = await response.json();
    const text = payload.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('AI Gateway returned an empty response.');

    return res.status(200).json({ message: text });
  } catch (error) {
    console.error('Chat request failed:', error);
    return res.status(502).json({ error: 'The assistant is temporarily unavailable. Please try again.' });
  }
}
