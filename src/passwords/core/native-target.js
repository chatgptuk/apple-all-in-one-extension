// Apple's native website-query protocol is not an arbitrary URL parser. Keep
// browser-internal, local-file and opaque document URLs out of native requests.
// This is a protocol boundary, not the user's separate HTTP filling preference.
export function normalizeNativeTarget(tabId, url) {
  const unsupported = () => {
    const error = new Error('Apple Passwords is unavailable on this page');
    error.code = 'unsupported_page';
    return error;
  };

  if (!Number.isInteger(tabId) || tabId < 0 || typeof url !== 'string' || !url.trim()) {
    throw unsupported();
  }

  let target;
  try {
    target = new URL(url);
  } catch (_) {
    throw unsupported();
  }
  if ((target.protocol !== 'http:' && target.protocol !== 'https:') || !target.hostname) {
    throw unsupported();
  }

  return { hostname: target.hostname, href: target.href };
}
