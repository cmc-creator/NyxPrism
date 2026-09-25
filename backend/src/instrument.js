// Error monitoring. Imported first by index.js so it is initialised before
// anything else loads. Does nothing unless SENTRY_DSN is set.
import * as Sentry from '@sentry/node';

const SENSITIVE_KEY = /pass(word)?|token|secret|authorization|cookie|api[-_]?key|document(base64|_data)?|pdftext|values|signature/i;

// Signing and distribution links carry 64-character secret tokens in their paths.
const hideTokens = text => (typeof text === 'string' ? text.replace(/[a-f0-9]{64}/gi, '[token]') : text);

function scrub(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return value;
  for (const key of Object.keys(value)) {
    if (SENSITIVE_KEY.test(key)) value[key] = '[redacted]';
    else if (typeof value[key] === 'string' && value[key].length > 2000) value[key] = value[key].slice(0, 200) + '…[truncated]';
    else if (typeof value[key] === 'string') value[key] = hideTokens(value[key]);
    else scrub(value[key], depth + 1);
  }
  return value;
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
    // No IP addresses, cookies or request bodies: users upload private documents.
    sendDefaultPii: false,
    tracesSampleRate: 0.05,
    // Most routes catch their errors and log them with console.error; report those too.
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
        if (event.request.query_string) event.request.query_string = '[redacted]';
        event.request.url = hideTokens(event.request.url);
      }
      event.transaction = hideTokens(event.transaction);
      event.message = hideTokens(event.message);
      if (event.logentry) event.logentry.message = hideTokens(event.logentry.message);
      for (const ex of event.exception?.values || []) ex.value = hideTokens(ex.value);
      for (const crumb of event.breadcrumbs || []) { crumb.message = hideTokens(crumb.message); if (crumb.data?.url) crumb.data.url = hideTokens(crumb.data.url); }
      scrub(event.extra);
      scrub(event.contexts);
      return event;
    },
    beforeSendTransaction(event) {
      event.transaction = hideTokens(event.transaction);
      if (event.request) { event.request.url = hideTokens(event.request.url); delete event.request.query_string; }
      return event;
    },
  });
}

export default Sentry;
