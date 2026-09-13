// Bubble's editor API.
//
// Two endpoints, both authenticated by the editor session cookie alone:
//
//   GET  bubble.io/appeditor/export/<version>/<app>.bubble   -> the whole app as JSON
//   POST bubble.io/appeditor/write                           -> one or more changes
//
// The export is a *rendered view*: it translates Bubble's short property codes into
// long names, one way and lossily. It is the right tool for addressing (ids, paths,
// structure) and the wrong tool for verifying a write. See runtime.mjs and verify.mjs.

import { assertBubbleHost, editorHeaders, SessionError } from './session.mjs';

const BASE = 'https://bubble.io';

export class BubbleApiError extends Error {
  constructor(message, { status, body, hint } = {}) {
    super(message);
    this.name = 'BubbleApiError';
    this.status = status;
    this.body = body;
    this.hint = hint;
  }
}

function explain(status, body, appname) {
  if (status === 401 || status === 403) {
    return new BubbleApiError(`Bubble refused access to "${appname}" (HTTP ${status})`, {
      status,
      body,
      hint:
        'Two things cause this. Either the session has expired — run `bubble-agent setup` ' +
        'again — or the app is on a free plan. Bubble gates the JSON export behind a paid ' +
        'plan, and without the export there are no ids or paths to work with.',
    });
  }
  if (status === 404) {
    return new BubbleApiError(`no such app: "${appname}"`, {
      status,
      body,
      hint: 'Use the app id exactly as it appears in the editor URL (?id=…).',
    });
  }
  return new BubbleApiError(`Bubble returned HTTP ${status} for "${appname}"`, { status, body });
}

/**
 * Fetch a whole app. `version` is a Bubble version ("test", "live"), never a branch —
 * branches are not reachable through this endpoint.
 */
export async function fetchExport(session, appname, version = 'test') {
  if (!appname) throw new SessionError('an app id is required');
  const url = assertBubbleHost(`${BASE}/appeditor/export/${encodeURIComponent(version)}/${encodeURIComponent(appname)}.bubble`);
  const res = await fetch(url, { headers: editorHeaders(session) });
  const text = await res.text();
  if (!res.ok) throw explain(res.status, text.slice(0, 400), appname);
  try {
    return JSON.parse(text);
  } catch {
    throw new BubbleApiError(`export for "${appname}" was not JSON (${text.length} bytes)`, {
      status: res.status,
      body: text.slice(0, 200),
    });
  }
}

/** Can this session read this app? Returns a small verdict object, never throws. */
export async function probeApp(session, appname, version = 'test') {
  try {
    const url = assertBubbleHost(`${BASE}/appeditor/export/${encodeURIComponent(version)}/${encodeURIComponent(appname)}.bubble`);
    const res = await fetch(url, { headers: editorHeaders(session) });
    const text = await res.text();
    if (res.ok) {
      let doc = null;
      try {
        doc = JSON.parse(text);
      } catch {
        /* handled below */
      }
      return {
        ok: true,
        appname,
        bytes: text.length,
        pages: doc ? Object.keys(doc.pages ?? {}).length : null,
        version: doc?.app_version ?? version,
      };
    }
    const err = explain(res.status, text.slice(0, 200), appname);
    return { ok: false, appname, status: res.status, reason: err.message, hint: err.hint };
  } catch (err) {
    return { ok: false, appname, reason: err.message, hint: err.hint };
  }
}

/**
 * Apply changes. Each change is `{ path, body, before }` where `path` is a dotted
 * Bubble path ("%p3.<page>.%el.<el>.%p.<code>"). A body of `null` deletes.
 *
 * Bubble answers 200 for a great many writes that do nothing useful — a property key
 * that does not exist for that element type is stored as dead weight and reported as
 * success. Nothing in this function can tell the difference; that is what the invariant
 * checks and the running-app verification exist for.
 */
export async function writeChanges(session, appname, changes, { version = 'test' } = {}) {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new SessionError('writeChanges needs at least one change');
  }
  const url = assertBubbleHost(`${BASE}/appeditor/write`);
  const payload = {
    v: 1,
    appname,
    app_version: version,
    changes: changes.map((c) => ({
      body: c.body === undefined ? null : c.body,
      path_array: String(c.path).split('.').filter(Boolean),
      intent: { name: 'SetData', id: 3, source_appname: '' },
      version_control_api_version: 5,
      changelog_data: [
        {
          operation: c.body === null ? 'deleted' : 'changed',
          before_value: JSON.stringify(c.before ?? null),
          after_value: JSON.stringify(c.body ?? null),
          display_name: c.label ?? 'bubble-agent change',
          type: 'Element',
          root: '',
          change_identifier: '',
          change_path: `${c.path}.`,
          inner_nodes_info: [],
          inner_node_count: 1,
        },
      ],
      session_id: `bubble-agent-${Date.now()}`,
    })),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: editorHeaders(session, { json: true }),
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  if (!res.ok) throw explain(res.status, text.slice(0, 400), appname);
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* Bubble occasionally answers with a bare body; the status is what matters */
  }
  return { status: res.status, ...(parsed ?? { raw: text.slice(0, 200) }) };
}

/** The app's last change marker — used to detect an editor open alongside us. */
export async function changeMarker(session, appname, version = 'test') {
  const doc = await fetchExport(session, appname, version);
  return {
    last_change: doc.last_change ?? null,
    last_change_date: doc.last_change_date ?? null,
    uid_counter: doc.uid_counter ?? null,
  };
}
