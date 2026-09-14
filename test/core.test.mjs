import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCodeTable, storageKey, longName, extractElementSchemas, defaultStyles, buildVocabulary,
} from '../src/core/codes.mjs';
import { readPath, findElements, findPage, mintIds, walkElements } from '../src/core/paths.mjs';
import {
  checkPropertyKeys, checkNode, findEscapeDamage, repairEscapes,
  orderReconciliation, checkStyleOwnership, preflight,
} from '../src/core/invariants.mjs';
import { redact, assertBubbleHost, SessionError } from '../src/core/session.mjs';
import { RUN_JS, DYNAMIC_JS, EXPORT_DOC } from './fixtures.mjs';

const vocabulary = buildVocabulary({ runJs: RUN_JS, dynamicJs: DYNAMIC_JS, exportDoc: EXPORT_DOC });

// ------------------------------------------------------------------ codes

test('the code table is found and parsed out of an engine bundle', () => {
  const t = extractCodeTable(RUN_JS);
  assert.equal(t.text, '3');
  assert.equal(t.placeholder, 'ps');
  assert.equal(t.bgcolor, 'bgc');
  assert.ok(Object.keys(t).length > 40);
});

test('a bundle with no table is rejected rather than half-parsed', () => {
  assert.throws(() => extractCodeTable(`var x=1;${'y'.repeat(2000)}`), /could not locate/);
  assert.throws(() => extractCodeTable('too short'), /too small/);
});

test('coded properties map to %code, long-named ones stay as they are', () => {
  assert.equal(storageKey(vocabulary.table, 'text'), '%3');
  assert.equal(storageKey(vocabulary.table, 'placeholder'), '%ps');
  // not in the table -> long name is the storage key
  assert.equal(storageKey(vocabulary.table, 'padding_left'), 'padding_left');
  assert.equal(storageKey(vocabulary.table, 'order'), 'order');
});

test('codes translate back to their long names', () => {
  assert.equal(longName(vocabulary.table, '%3'), 'text');
  assert.equal(longName(vocabulary.table, '%bgc'), 'bgcolor');
  assert.equal(longName(vocabulary.table, '%nope'), null);
  assert.equal(longName(vocabulary.table, 'padding_left'), 'padding_left');
});

test('per-type schemas come out of make_element', () => {
  const s = extractElementSchemas(RUN_JS);
  assert.deepEqual(s.Video.fields, ['video_source', 'video_id', 'autoplay', 'loop']);
  assert.ok(s.Text.fields.includes('text'));
});

test('default styles are read from app settings, not the engine', () => {
  assert.equal(defaultStyles({ dynamicJs: DYNAMIC_JS }).Text, 'Text_body_16_');
  assert.deepEqual(defaultStyles({}), {});
});

// ------------------------------------------------------------------ paths

test('a path walks the export through its short segments', () => {
  assert.equal(readPath(EXPORT_DOC, '%p3.PAGEA').name, 'home');
  assert.equal(readPath(EXPORT_DOC, '%p3.PAGEA.%el.GRPA.%el.TXTA').name, 'txt: headline');
  assert.equal(readPath(EXPORT_DOC, '%p3.NOPE'), undefined);
});

test('a coded property resolves only when the vocabulary is supplied', () => {
  const p = '%p3.PAGEA.%el.GRPA.%el.TXTA.%p.%3';
  // this is the bug that made a revert delete instead of restore
  assert.equal(readPath(EXPORT_DOC, p), undefined);
  assert.equal(readPath(EXPORT_DOC, p, vocabulary).entries[0], 'hello');
});

test('long-named properties resolve either way', () => {
  const p = '%p3.PAGEA.%el.GRPA.%el.TXTA.%p.padding_left';
  assert.equal(readPath(EXPORT_DOC, p), 8);
  assert.equal(readPath(EXPORT_DOC, p, vocabulary), 8);
});

test('pages and elements are findable by name, key or id', () => {
  assert.equal(findPage(EXPORT_DOC, 'home').key, 'PAGEA');
  assert.equal(findPage(EXPORT_DOC, 'PAGEA').name, 'home');
  assert.equal(findPage(EXPORT_DOC, 'pg1').name, 'home');
  const { matches } = findElements(EXPORT_DOC, 'home', 'headline');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].path, '%p3.PAGEA.%el.GRPA.%el.TXTA');
});

test('the element walk descends into children', () => {
  const all = walkElements(EXPORT_DOC.pages.PAGEA, '%p3.PAGEA');
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((e) => e.depth), [0, 1]);
});

test('minted ids avoid everything already in use', () => {
  const ids = mintIds(EXPORT_DOC, { count: 3 });
  assert.equal(ids.length, 3);
  const used = new Set(['PAGEA', 'GRPA', 'TXTA', 'pg1', 'el1', 'el2']);
  for (const { key, id } of ids) {
    assert.ok(!used.has(key));
    assert.ok(!used.has(id));
    assert.notEqual(key, id);
  }
});

// ------------------------------------------------------------------ invariants

test('a long name for a coded property is refused, with the fix', () => {
  const r = checkPropertyKeys({ text: 'x' }, vocabulary);
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].kind, 'long-name-for-coded-property');
  assert.equal(r.problems[0].fix, '%3');
});

test('a genuinely long-named property is accepted', () => {
  assert.equal(checkPropertyKeys({ padding_left: 8, order: 1 }, vocabulary).ok, true);
});

test('an unknown code is refused', () => {
  const r = checkPropertyKeys({ '%zzz': 1 }, vocabulary);
  assert.equal(r.problems[0].kind, 'unknown-code');
});

test('structural keys are not mistaken for properties', () => {
  assert.equal(checkPropertyKeys({ '%x': 'Text', id: 'a', '%nm': 'n', '%el': {} }, vocabulary).ok, true);
});

test('the whole node is checked, states and children included', () => {
  const node = {
    '%p': { '%3': 'ok' },
    '%s': { 0: { '%p': { font_size: 12 } } },
    '%el': { A: { '%p': { bgcolor: 'red' } } },
  };
  const r = checkNode(node, vocabulary);
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
  assert.ok(r.problems.some((p) => p.where.includes('%s.0')));
  assert.ok(r.problems.some((p) => p.where.includes('%el.A')));
});

test('double-escaped strings are found anywhere in a structure', () => {
  const hits = findEscapeDamage({ a: { b: 'All\\nPaid' }, c: 'fine' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'a.b');
});

test('escape damage is repairable', () => {
  assert.equal(repairEscapes({ x: 'a\\nb' }).x, 'a\nb');
  assert.equal(findEscapeDamage(repairEscapes({ x: 'a\\nb' })).length, 0);
});

test('order reconciliation covers every descendant', () => {
  const node = { '%el': { A: { '%el': { C: {} } }, B: {} } };
  const jobs = orderReconciliation(node, 'ROOT');
  assert.deepEqual(
    jobs.filter((j) => j.path.endsWith('.order')).map((j) => `${j.path}=${j.value}`),
    ['ROOT.%el.A.%p.order=1', 'ROOT.%el.A.%el.C.%p.order=1', 'ROOT.%el.B.%p.order=2'],
  );
});

test('a property owned by a named style warns rather than refuses', () => {
  const node = { '%s1': 'Text_body_16_', '%p': { font_size: 20 } };
  const r = checkStyleOwnership(node, EXPORT_DOC.styles);
  assert.equal(r.ok, true);
  assert.equal(r.warnings.length, 1);
});

test('preflight separates refusals from warnings', () => {
  const r = preflight(
    { '%s1': 'Text_body_16_', '%p': { text: 'bad', font_size: 20, note: 'a\\nb' } },
    { vocabulary, styles: EXPORT_DOC.styles },
  );
  assert.equal(r.ok, false);
  assert.ok(r.refusals.some((x) => x.code === 'long-name-for-coded-property'));
  assert.ok(r.refusals.some((x) => x.code === 'escape-damage'));
  assert.ok(r.warnings.length >= 1);
});

// ------------------------------------------------------------------ secrets

test('the cookie is stripped from anything emitted', () => {
  const session = { cookie: 'u=abcdef1234567890abcdef; _uid=zzzz9999888877776666' };
  const out = redact(`failed with cookie ${session.cookie} while writing`, session);
  assert.ok(!out.includes('abcdef1234567890abcdef'));
  assert.ok(out.includes('«redacted:session»'));
});

test('cookie-shaped values are stripped even with no session loaded', () => {
  const out = redact('Cookie: u=QQQQwwwwEEEErrrrTTTTyyyy1234; other=1');
  assert.ok(!out.includes('QQQQwwwwEEEErrrrTTTTyyyy1234'));
});

test('the cookie is only ever sent to bubble.io', () => {
  assert.equal(assertBubbleHost('https://bubble.io/appeditor/write'), 'https://bubble.io/appeditor/write');
  assert.throws(() => assertBubbleHost('https://evil.example/steal'), SessionError);
  assert.throws(() => assertBubbleHost('https://bubble.io.evil.example/x'), /refusing/);
  assert.throws(() => assertBubbleHost('not a url'), SessionError);
});

// ------------------------------------------------------- revert safety (regression)

import { planRevert } from '../src/core/change.mjs';

test('a created path is undone by deleting it', () => {
  const { changes, unsafe } = planRevert({ before: [{ path: 'P', value: null, existed: false }] });
  assert.equal(unsafe.length, 0);
  assert.deepEqual(changes.map((c) => [c.path, c.body]), [['P', null]]);
});

test('an updated path is undone by restoring its previous value', () => {
  const prev = { entries: { 0: 'before' }, type: 'TextExpression' };
  const { changes, unsafe } = planRevert({ before: [{ path: 'P', value: prev, existed: true }] });
  assert.equal(unsafe.length, 0);
  assert.deepEqual(changes[0].body, prev);
});

test('REGRESSION: a path that existed but was not captured is never reverted with null', () => {
  // This is the bug that deleted a live element: path resolution failed, `before` came
  // back undefined, and the revert wrote null — which in Bubble deletes.
  const { changes, unsafe } = planRevert({ before: [{ path: 'P', value: null, existed: true }] });
  assert.deepEqual(unsafe, ['P']);
  assert.equal(changes.length, 0);
});

test('a mixed snapshot refuses only the unsafe entries', () => {
  const { changes, unsafe } = planRevert({
    before: [
      { path: 'A', value: 1, existed: true },
      { path: 'B', value: null, existed: false },
      { path: 'C', value: undefined, existed: true },
    ],
  });
  assert.deepEqual(unsafe, ['C']);
  assert.deepEqual(changes.map((c) => c.path), ['A', 'B']);
});

// ------------------------------------------- dev password parsing (regression)

import { splitDevPassword } from '../src/core/runtime.mjs';

test('a dev password with no username is sent with an empty user', () => {
  assert.deepEqual(splitDevPassword('secret'), { user: '', pass: 'secret' });
});

test('username:password splits on the first colon', () => {
  assert.deepEqual(splitDevPassword('admin:secret'), { user: 'admin', pass: 'secret' });
});

test('REGRESSION: a colon inside the password is preserved, not truncated', () => {
  // splitting on every colon silently dropped everything after the second one,
  // producing an auth failure with nothing to point at
  assert.deepEqual(splitDevPassword('admin:pa:ss:word'), { user: 'admin', pass: 'pa:ss:word' });
});

test('a leading colon means no username', () => {
  assert.deepEqual(splitDevPassword(':onlypass'), { user: '', pass: 'onlypass' });
});
