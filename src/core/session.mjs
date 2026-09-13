// Credential handling.
//
// One Bubble editor session cookie is full read/write access to EVERY app on the
// account. It is not scoped to an app, a page or an operation, and Bubble offers no
// narrower credential. Everything here follows from that:
//
//   - a 0600 file in a 0700 directory is the default store; the macOS keychain is
//     opt-in via BUBBLE_AGENT_STORE=keychain, with the trade-off spelled out at
//     keychainWrite() — it cannot be used without a brief argv exposure
//   - the cookie is never accepted as a command-line argument to THIS tool
//     (shell history, ps)
//   - redact() runs over anything this tool emits, including crash traces
//   - every request asserts its host before the cookie is attached
//
// Rotate by logging out of Bubble, which invalidates the cookie server-side.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

const SERVICE = 'bubble-agent';
const ACCOUNT = 'editor-session';
const CONFIG_DIR = process.env.BUBBLE_AGENT_HOME || join(homedir(), '.config', 'bubble-agent');
const FILE_PATH = join(CONFIG_DIR, 'session.json');

/** Hosts the cookie may ever be sent to. Anything else is a bug or an attack. */
export const ALLOWED_HOSTS = new Set(['bubble.io', 'www.bubble.io']);

export class SessionError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = 'SessionError';
    this.hint = hint;
  }
}

// ---------------------------------------------------------------- redaction

/**
 * Strip the live cookie, and anything cookie-shaped, out of text before it is shown.
 * Applied to tool output, log lines and error traces alike.
 */
export function redact(text, session = null) {
  let out = typeof text === 'string' ? text : String(text ?? '');
  const cookie = session?.cookie;
  if (cookie && cookie.length >= 8) {
    out = out.split(cookie).join('«redacted:session»');
    for (const part of cookie.split(/;\s*/)) {
      const value = part.includes('=') ? part.slice(part.indexOf('=') + 1) : part;
      if (value.length >= 12) out = out.split(value).join('«redacted:session»');
    }
  }
  // catch-all for session-shaped pairs even when no session is loaded
  return out.replace(
    /\b(u|_uid|bubble_session|session|sid)=([A-Za-z0-9._%+\-]{16,})/gi,
    (_m, k) => `${k}=«redacted:session»`,
  );
}

/** Wrap a function so any thrown message/stack is redacted before it escapes. */
export function guardSecrets(fn, session = null) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      const e = new Error(redact(err?.message ?? String(err), session));
      e.stack = redact(err?.stack ?? '', session);
      e.cause = undefined;
      throw e;
    }
  };
}

// ---------------------------------------------------------------- keychain

function keychainAvailable() {
  if (platform() !== 'darwin') return false;
  try {
    execFileSync('/usr/bin/security', ['-h'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Write to the macOS keychain.
 *
 * MEASURED TRADE-OFF, and the reason this is not the default store: `security` reads a
 * password from stdin but truncates it at 128 bytes, with no error. A Bubble session
 * cookie is roughly 1,600 characters, so the safe input path cannot carry it. Passing
 * the value as an argument is the only way to store it intact, and an argument is
 * visible in `ps` for the lifetime of the call.
 *
 * So: the 0600 file is the default, and the keychain is opt-in for people who would
 * rather have encryption at rest than avoid a momentary argv exposure. Both are real
 * positions; neither is silently chosen for you.
 */
function keychainWrite(json) {
  if (json.includes('\n')) throw new SessionError('refusing to store a multi-line secret in the keychain');
  execFileSync(
    '/usr/bin/security',
    ['add-generic-password', '-U', '-a', ACCOUNT, '-s', SERVICE, '-w', json],
    { stdio: 'ignore' },
  );
}

function keychainRead() {
  try {
    const out = execFileSync(
      '/usr/bin/security',
      ['find-generic-password', '-a', ACCOUNT, '-s', SERVICE, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const raw = out.trim();
    if (!raw) return null;
    // `security -w` hex-encodes the secret whenever it contains a newline or any
    // non-ASCII byte, and gives no signal that it did. A stored session is always
    // JSON, so if an all-hex payload decodes to something starting with `{`, it was
    // encoded; anything else is returned as written.
    if (/^(?:[0-9a-fA-F]{2})+$/.test(raw)) {
      const decoded = Buffer.from(raw, 'hex').toString('utf8');
      if (decoded.trimStart().startsWith('{')) return decoded;
    }
    return raw;
  } catch {
    return null;
  }
}

function keychainDelete() {
  try {
    execFileSync('/usr/bin/security', ['delete-generic-password', '-a', ACCOUNT, '-s', SERVICE], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- file store

function fileWrite(json) {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  try {
    chmodSync(CONFIG_DIR, 0o700);
  } catch {
    /* best effort on filesystems without modes */
  }
  writeFileSync(FILE_PATH, `${json}\n`, { mode: 0o600 });
  try {
    chmodSync(FILE_PATH, 0o600);
  } catch {
    /* as above */
  }
}

function fileRead() {
  if (!existsSync(FILE_PATH)) return null;
  const mode = statSync(FILE_PATH).mode & 0o777;
  if (platform() !== 'win32' && mode !== 0o600) {
    throw new SessionError(`session file has mode ${mode.toString(8)}, refusing to read it`, {
      hint: `run: chmod 600 ${FILE_PATH}`,
    });
  }
  return readFileSync(FILE_PATH, 'utf8');
}

// ---------------------------------------------------------------- public API

/**
 * Persist a session. `cookie` must come from stdin or an interactive prompt, never
 * from argv.
 */
export function saveSession({ cookie, userAgent, ttlHours = 12, store = process.env.BUBBLE_AGENT_STORE || 'file' }) {
  if (typeof cookie !== 'string' || cookie.length < 20) {
    throw new SessionError('that does not look like a Bubble editor cookie');
  }
  const now = Date.now();
  const session = {
    cookie: cookie.trim(),
    user_agent:
      userAgent ||
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
    captured_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlHours * 3600_000).toISOString(),
    ttl_hours: ttlHours,
  };
  // compact: a newline is what makes `security` hex-encode on read
  const json = JSON.stringify(session);
  const useKeychain = store === 'keychain' && keychainAvailable();
  if (store === 'keychain' && !keychainAvailable()) {
    throw new SessionError('keychain storage was requested but the macOS keychain is not available here');
  }
  if (useKeychain) {
    keychainWrite(json);
    session.stored_in = 'keychain';
    // if a file copy exists from an earlier run, remove it rather than leave two
    if (existsSync(FILE_PATH)) rmSync(FILE_PATH);
  } else {
    fileWrite(JSON.stringify(session, null, 2));
    session.stored_in = `file ${FILE_PATH}`;
  }
  return session;
}

/** Load the stored session, or null. Throws only on a malformed/unsafe store. */
export function loadSession() {
  let raw = null;
  let where = null;
  if (keychainAvailable()) {
    raw = keychainRead();
    where = 'keychain';
  }
  if (!raw) {
    raw = fileRead();
    where = raw ? `file ${FILE_PATH}` : null;
  }
  if (!raw) return null;
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    throw new SessionError('stored session is not valid JSON; run `bubble-agent setup` again');
  }
  session.stored_in = where;
  session.expired = Boolean(session.expires_at && Date.parse(session.expires_at) < Date.now());
  return session;
}

/** Remove the session from every store. */
export function clearSession() {
  const removed = [];
  if (keychainDelete()) removed.push('keychain');
  if (existsSync(FILE_PATH)) {
    rmSync(FILE_PATH);
    removed.push(FILE_PATH);
  }
  return removed;
}

/** A session or a clear explanation of why there isn't one. */
export function requireSession() {
  const s = loadSession();
  if (!s) {
    throw new SessionError('no Bubble session stored', { hint: 'run: bubble-agent setup' });
  }
  if (s.expired) {
    throw new SessionError('the stored Bubble session has passed its TTL', {
      hint: 'run: bubble-agent setup  (capture a fresh cookie)',
    });
  }
  return s;
}

/**
 * Headers for a Bubble editor request. Measured 13 September 2026: reading needs only
 * the cookie, writing needs only the cookie plus Content-Type. The X-Bubble-* headers
 * some clients send — including a pinned client-version hash — are not required, so
 * nothing here is coupled to a Bubble build number.
 */
export function editorHeaders(session, { json = false } = {}) {
  const h = {
    Cookie: session.cookie,
    'User-Agent': session.user_agent,
    Accept: '*/*',
  };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

/** Refuse to attach the cookie to anything that is not Bubble. */
export function assertBubbleHost(url) {
  let host;
  try {
    host = new URL(url).host;
  } catch {
    throw new SessionError(`not a URL: ${url}`);
  }
  if (!ALLOWED_HOSTS.has(host)) {
    throw new SessionError(
      `refusing to send the session cookie to ${host}; only ${[...ALLOWED_HOSTS].join(', ')} are allowed`,
    );
  }
  return url;
}

export const SESSION_FILE = FILE_PATH;
export const CONFIG_HOME = CONFIG_DIR;
