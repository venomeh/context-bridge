// The checks that stand in for a human watching.
//
// Every one of these exists because something broke on a live app. They share a
// failure signature: Bubble answers HTTP 200, and the export renders the damage as
// correct, so nothing downstream notices. Unattended that is worse, not better, which
// is why these are enforced in core rather than left to the caller.

import { longName } from './codes.mjs';

/** Keys that are structure, not properties, and are never code-mapped. */
const STRUCTURAL = new Set([
  '%p', '%x', 'id', '%dn', '%nm', '%s1', '%el', '%s', '%v', '%c', '%e', '%n', '%a',
  'actions', 'custom_states', 'is_slidable', 'rank', 'type', 'properties', 'elements',
]);

export class InvariantViolation extends Error {
  constructor(message, { code, detail } = {}) {
    super(message);
    this.name = 'InvariantViolation';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A long name that HAS a short code is the junk-property trap: written as-is, Bubble
 * stores a key the app never reads, returns 200, and the export renders it under the
 * same name as the real property so the mistake is invisible.
 */
export function checkPropertyKeys(props, vocabulary, { where = 'properties' } = {}) {
  const problems = [];
  for (const key of Object.keys(props ?? {})) {
    if (STRUCTURAL.has(key)) continue;
    if (key.startsWith('%')) {
      if (!longName(vocabulary.table, key)) {
        problems.push({
          key,
          kind: 'unknown-code',
          message: `"${key}" is not a code in this app's Bubble build`,
        });
      }
      continue;
    }
    const code = vocabulary.table[key];
    if (code) {
      problems.push({
        key,
        kind: 'long-name-for-coded-property',
        message: `"${key}" must be written as "%${code}" — the long name is stored and ignored`,
        fix: `%${code}`,
      });
    }
  }
  return { ok: problems.length === 0, where, problems };
}

/** Walk a whole node (properties, states, children) applying checkPropertyKeys. */
export function checkNode(node, vocabulary, path = '') {
  const all = [];
  const visit = (n, p) => {
    if (!n || typeof n !== 'object') return;
    if (n['%p']) {
      const r = checkPropertyKeys(n['%p'], vocabulary, { where: `${p}.%p` });
      all.push(...r.problems.map((x) => ({ ...x, where: `${p}.%p` })));
    }
    for (const [sk, sv] of Object.entries(n['%s'] ?? {})) {
      if (sv?.['%p']) {
        const r = checkPropertyKeys(sv['%p'], vocabulary, { where: `${p}.%s.${sk}.%p` });
        all.push(...r.problems.map((x) => ({ ...x, where: `${p}.%s.${sk}.%p` })));
      }
    }
    for (const [ck, cv] of Object.entries(n['%el'] ?? {})) visit(cv, `${p}.%el.${ck}`);
  };
  visit(node, path || '<node>');
  return { ok: all.length === 0, problems: all };
}

/**
 * Strings carrying a literal backslash escape.
 *
 * A page bundle is JavaScript handing a JSON *string* to JSON.parse, so a newline
 * inside a value is written `\\n`. Slicing the bundle and JSON.parsing once decodes
 * only the outer level and yields a literal backslash-n. Copying a subtree that way
 * and writing it back turns a four-line dropdown into one unusable option — at 200,
 * with the export showing `"All\\nPaid"`, which reads as fine at a glance.
 */
export function findEscapeDamage(value, path = '') {
  const hits = [];
  const walk = (v, p) => {
    if (typeof v === 'string') {
      if (/\\[nrt"\\]/.test(v)) hits.push({ path: p, sample: v.slice(0, 60) });
      return;
    }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, p ? `${p}.${k}` : k);
  };
  walk(value, path);
  return hits;
}

/** Repair escape damage in place, returning a cleaned copy. */
export function repairEscapes(value) {
  if (typeof value === 'string') return value.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r');
  if (Array.isArray(value)) return value.map(repairEscapes);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = repairEscapes(v);
    return out;
  }
  return value;
}

/**
 * Is someone editing this app right now? Bubble's editor holds a stale in-memory copy
 * and autosaves over it, so a write landing beside an open editor can be silently
 * undone. Two reads with no write between them should report the same marker.
 */
export async function checkEditorIdle(readMarker, { samples = 2, gapMs = 4000 } = {}) {
  const seen = [];
  for (let i = 0; i < samples; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, gapMs));
    seen.push(await readMarker());
  }
  const first = JSON.stringify(seen[0]);
  const moved = seen.some((s) => JSON.stringify(s) !== first);
  return {
    ok: !moved,
    moved,
    samples: seen,
    message: moved
      ? 'the app changed while nothing here was writing — someone has the editor open'
      : 'no edits observed from elsewhere',
  };
}

/**
 * A property defined by a named style is inert when set inline: the write succeeds and
 * changes nothing visible. Warns rather than refuses, because overriding a style
 * property on one element is sometimes exactly what is wanted.
 */
export function checkStyleOwnership(node, styles) {
  const styleId = node?.['%s1'];
  if (!styleId || !styles?.[styleId]) return { ok: true, warnings: [] };
  const owned = new Set(Object.keys(styles[styleId].properties ?? {}));
  const warnings = [];
  for (const key of Object.keys(node['%p'] ?? {})) {
    const name = key.startsWith('%') ? null : key;
    if (name && owned.has(name)) {
      warnings.push({ key, style: styleId, message: `"${name}" is defined by style ${styleId}` });
    }
  }
  return { ok: true, warnings };
}

/**
 * Sibling order. Bubble renormalises the `order` property of nested nodes inside a
 * bulk subtree write; single-property writes to `<path>.%p.order` are honoured
 * exactly. So after writing a subtree, order has to be reconciled, never assumed.
 * Returns the per-child writes needed to make stored order match intended order.
 */
export function orderReconciliation(node, basePath) {
  const jobs = [];
  const walk = (n, p) => {
    const kids = Object.entries(n['%el'] ?? {});
    kids.forEach(([k, c], i) => {
      const cp = `${p}.%el.${k}`;
      jobs.push({ path: `${cp}.%p.order`, value: i + 1 });
      jobs.push({ path: `${cp}.%p.%z`, value: i + 2 });
      walk(c, cp);
    });
  };
  walk(node, basePath);
  return jobs;
}

/** Run every pre-write check, returning refusals and warnings separately. */
export function preflight(node, { vocabulary, styles } = {}) {
  const refusals = [];
  const warnings = [];

  if (vocabulary) {
    const keys = checkNode(node, vocabulary);
    for (const p of keys.problems) {
      refusals.push({ code: p.kind, where: p.where, message: p.message, fix: p.fix });
    }
  }
  for (const hit of findEscapeDamage(node)) {
    refusals.push({
      code: 'escape-damage',
      where: hit.path,
      message: `literal backslash escape in a string value: ${JSON.stringify(hit.sample)}`,
      fix: 'decode both levels, or repair with repairEscapes()',
    });
  }
  if (styles) warnings.push(...checkStyleOwnership(node, styles).warnings);

  return { ok: refusals.length === 0, refusals, warnings };
}
