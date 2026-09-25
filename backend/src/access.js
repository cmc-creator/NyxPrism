const ownerEmails = ['cmc@conniemichelleconsulting.com'];
// Permanent full-access account for app store certification reviewers.
const reviewerEmails = ['msstore-review@nyxprism.com'];
const developerEmails = new Set(
  [ownerEmails.join(','), reviewerEmails.join(','), process.env.DEVELOPER_EMAILS || '']
    .join(',')
    .split(',')
    .map(email => email.trim().toLowerCase())
    .filter(Boolean),
);

export function isOwner(email) {
  return typeof email === 'string' && ownerEmails.includes(email.trim().toLowerCase());
}

export function isDeveloper(email) {
  return typeof email === 'string' && developerEmails.has(email.trim().toLowerCase());
}

const TRIAL_DAYS = 14;
// Stripe keeps retrying a failed renewal while the subscription is past_due,
// so paying customers keep access during that window.
const PAID_STATUSES = ['active', 'trialing', 'past_due'];

/**
 * True when an account may use Professional features: a paid Professional
 * subscription, an unexpired trial, or an owner/reviewer account.
 * A free account's subscription_status is "active" too, so status alone
 * is never enough - the plan must be professional or trial.
 */
export function hasProfessionalAccess(account, email) {
  if (isDeveloper(email ?? account?.email)) return true;
  if (!account) return false;
  if (account.plan === 'professional') return PAID_STATUSES.includes(account.subscription_status);
  if (account.plan === 'trial') {
    const start = account.trial_start ? new Date(account.trial_start).getTime() : Date.now();
    return Date.now() <= start + TRIAL_DAYS * 24 * 60 * 60 * 1000;
  }
  return false;
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
