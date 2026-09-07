/** A lost reply does not establish that a native authorization was never sent. */
export function canRetryPasswordRequest(type: unknown, error: unknown): boolean {
  const message = String(error);
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) return true;
  const readOnly = ['getState', 'getLogins', 'getOtpItems', 'getSitePreferences', 'getDiagnostics'].includes(String(type));
  return readOnly && /message port closed/i.test(message);
}
