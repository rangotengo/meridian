/**
 * Presentation gates for UI that is temporarily hidden.
 *
 * These are compile-time constants on purpose: flipping one restores the
 * UI exactly as it was. They gate rendering only — the underlying data,
 * server actions, and authorization rules are untouched, so anything
 * already in effect (e.g. existing account shares) keeps working while
 * the entry points are hidden.
 */

/**
 * Account sharing entry points (the Sharing card on the account page and
 * the Share dialog in account actions) are hidden for now. Existing share
 * records and the access they grant are unaffected.
 */
export const ACCOUNT_SHARING_UI_ENABLED = false;
