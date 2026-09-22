const ownerEmails = ['cmc@conniemichelleconsulting.com'];
const developerEmails = new Set(
  [ownerEmails.join(','), process.env.DEVELOPER_EMAILS || '']
    .join(',')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean),
);

export function isDeveloper(email) {
  return typeof email === 'string' && developerEmails.has(email.trim().toLowerCase());
}

export function developerEntitlements(email) {
  if (!isDeveloper(email)) return null;
  return {
    plan: 'professional',
    subscription_status: 'active',
    trial_active: false,
    trial_start: null,
    current_period_end: null,
  };
}
