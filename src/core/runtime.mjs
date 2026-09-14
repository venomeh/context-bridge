// The running app — the only honest source of truth.
//
// The editor export renders Bubble's short property codes into long names. That
// translation is one-way, so a write that stored a dead key under a long name comes
// back out of the export looking exactly like the real thing. Measured on a live app:
// after writing `placeholder` where `%ps` was required, the placeholder string appeared
// ZERO times in the entire export and exactly once in the running app.
//
// So: address with the export, verify here.
//
//   https://<app>.bubbleapps.io/version-<version>/<page>
//     -> /package/static_js/…/static.js    styles, settings
//     -> /package/dynamic_js/…/dynamic.js  the page tree, in stored short-code form
//     -> /package/run_js/…/run.js          Bubble's engine (see codes.mjs)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export class RuntimeError extends Error {
  constructor(message, { status, hint } = {}) {
    super(message);
    this.name = 'RuntimeError';
    this.status = status;
    this.hint = hint;
  }
}

/** Where a given app's running copy lives. `origin` overrides for custom domains. */
export function runtimeUrl(appname, { version = 'test', page = '', origin } = {}) {
  const base = origin || `https://${appname}.bubbleapps.io`;
  const path = page && page !== 'index' ? `/${page}` : '/';
  return `${base}/version-${version}${path}`.replace(/\/+$/, (m) => (path === '/' ? '/' : m));
}

/**
 * Basic-auth header for the running app's dev-version protection.
 *
 * `devPassword` is "username:password", or just "password" when the app sets no
 * username. Split on the FIRST colon only — a colon is legal inside a password, and
 * splitting on all of them silently truncated it, producing an auth failure with
 * nothing to point at.
 */
export function splitDevPassword(devPassword) {
  const raw = String(devPassword ?? '');
  const at = raw.indexOf(':');
  return at >= 0 ? { user: raw.slice(0, at), pass: raw.slice(at + 1) } : { user: '', pass: raw };
}

function authHeaders(devPassword) {
  const h = { 'User-Agent': UA };
  if (devPassword) {
    const { user, pass } = splitDevPassword(devPassword);
    h.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
  }
  return h;
}

/**
 * Fetch a page of the running app and the JS bundles it loads.
 *
 * `devPassword` is the development-version password if the app has one, as "user:pass"
 * or just "pass". It is NOT the Bubble account credential and never leaves this host.
 */
export async function fetchRuntime(appname, { version = 'test', page = '', devPassword, origin, want = ['dynamic'] } = {}) {
  const url = runtimeUrl(appname, { version, page, origin });
  const headers = authHeaders(devPassword);
  const res = await fetch(url, { headers, redirect: 'follow' });
  const html = await res.text();
  if (res.status === 401) {
    throw new RuntimeError(`the running app at ${url} is password protected`, {
      status: 401,
      hint:
        'Pass the development-version password (Settings → General → "Password to protect ' +
        'the dev version") so writes can be verified against the real app rather than the export.',
    });
  }
  if (!res.ok) {
    throw new RuntimeError(`running app returned HTTP ${res.status} for ${url}`, { status: res.status });
  }

  const out = { url, status: res.status, html, bundles: {} };
  const srcs = [...html.matchAll(/src="(\/package\/(static|dynamic|run)_js\/[^"]+)"/g)];
  for (const [, path, kind] of srcs) {
    if (!want.includes(kind)) continue;
    const bundleUrl = `${new URL(url).origin}${path}`;
    const r = await fetch(bundleUrl, { headers });
    if (!r.ok) continue;
    out.bundles[kind] = { url: bundleUrl, text: await r.text() };
  }
  const missing = want.filter((k) => !out.bundles[k]);
  if (missing.length) {
    throw new RuntimeError(
      `the running app did not serve ${missing.join(', ')} for ${url}`,
      { hint: 'The page may not exist in this version, or the app has never been deployed to it.' },
    );
  }
  return out;
}

/**
 * Pull the balanced JSON object that follows `"<key>":` out of bundle text.
 *
 * IMPORTANT: this decodes ONE level. The bundle is JavaScript handing a JSON *string*
 * to JSON.parse, so a value that contained a newline is written `\\n` in the file and
 * comes back here as a literal backslash-n. Never write the result of this function
 * back to Bubble without running `findEscapeDamage` over it first.
 */
export function extractNode(text, key) {
  const needle = `"${key}":{`;
  const at = text.indexOf(needle);
  if (at < 0) return null;
  const start = at + needle.length - 1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === '\\') {
      esc = true;
      continue;
    }
    if (ch === '"') {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Does the running app contain this object key at all? */
export function hasKey(text, key) {
  return text.includes(`"${key}":{`);
}

/** Which element types the running app actually instantiates on this page. */
export function elementTypes(text) {
  const seen = new Set();
  for (const m of text.matchAll(/"%x":"([A-Z][A-Za-z]+)"/g)) seen.add(m[1]);
  return [...seen].sort();
}
