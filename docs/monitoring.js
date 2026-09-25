// Browser error reporting (Sentry). Runs only on the live and staging sites, and
// never sends page contents, typed values, cookies, or the secret tokens in
// signing and document links.
(function () {
  if (!window.Sentry || !/nyxprism\.com$|\.vercel\.app$/.test(location.hostname)) return;
  var hideTokens = function (text) {
    return typeof text === 'string'
      ? text.replace(/([?&](token|team_invite)=)[^&#\s]+/gi, '$1[token]').replace(/[a-f0-9]{48,64}/gi, '[token]')
      : text;
  };
  window.Sentry.init({
    dsn: 'https://19431bba073b39fa29dee9c55415f7c6@o4511152518004736.ingest.us.sentry.io/4512147977404416',
    environment: (window.NYX_ENV || 'production') + '-web',
    sendDefaultPii: false,
    sampleRate: 1.0,
    ignoreErrors: ['ResizeObserver loop limit exceeded', 'ResizeObserver loop completed with undelivered notifications', 'Non-Error promise rejection captured'],
    beforeSend: function (event) {
      if (event.request) { event.request.url = hideTokens(event.request.url); delete event.request.cookies; delete event.request.headers; }
      event.message = hideTokens(event.message);
      (event.exception && event.exception.values || []).forEach(function (ex) { ex.value = hideTokens(ex.value); });
      (event.breadcrumbs || []).forEach(function (b) {
        b.message = hideTokens(b.message);
        if (b.data) { if (b.data.url) b.data.url = hideTokens(b.data.url); if (b.data.to) b.data.to = hideTokens(b.data.to); if (b.data.from) b.data.from = hideTokens(b.data.from); }
      });
      return event;
    },
  });
})();
