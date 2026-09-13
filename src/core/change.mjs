// propose -> preview -> apply.
//
// The split is not ceremony. Every silent failure this tool guards against returned
// HTTP 200 and rendered as correct in the export; the only defence that survives an
// unattended run is a step that states exactly what will change before it changes, and
// a step afterwards that reads the result back out of the running app rather than the
// export.

import { randomUUID } from 'node:crypto';
import { writeChanges, fetchExport, changeMarker } from './api.mjs';
import { fetchRuntime, extractNode, hasKey } from './runtime.mjs';
import { readPath, pathExists, parentPath } from './paths.mjs';
import { preflight, checkEditorIdle, orderReconciliation } from './invariants.mjs';

const proposals = new Map();

export class ChangeError extends Error {
  constructor(message, { code, detail } = {}) {
    super(message);
    this.name = 'ChangeError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Build a proposal. Writes nothing.
 *
 * `changes` is [{ path, body, label? }]. A body of null is a deletion. Every path is
 * resolved against the current export so the proposal can state what is there now, and
 * every node is run through the invariant checks before anything is offered.
 */
export function propose(ctx, changes, { note } = {}) {
  if (!Array.isArray(changes) || !changes.length) {
    throw new ChangeError('a proposal needs at least one change');
  }
  const items = changes.map((c) => {
    if (!c?.path) throw new ChangeError('every change needs a path');
    // vocabulary-aware: a coded property is stored as %3 but exported as `text`
    const before = readPath(ctx.doc, c.path, ctx.vocabulary);
    const exists = before !== undefined;
    const isDelete = c.body === null;
    const isSubtree = Boolean(c.body && typeof c.body === 'object' && c.body['%el']);

    const checks = isDelete
      ? { ok: true, refusals: [], warnings: [] }
      : preflight(
          c.body && typeof c.body === 'object' && c.body['%p'] ? c.body : { '%p': c.body },
          { vocabulary: ctx.vocabulary, styles: ctx.doc?.styles },
        );

    // a parent that does not exist means this write creates a path to nowhere
    const parent = parentPath(c.path);
    const parentOk = !parent || pathExists(ctx.doc, parent);
    if (!parentOk) {
      checks.refusals.push({
        code: 'missing-parent',
        where: parent,
        message: `parent path "${parent}" does not exist; writing here creates an orphan`,
      });
      checks.ok = false;
    }

    return {
      path: c.path,
      label: c.label ?? null,
      operation: isDelete ? 'delete' : exists ? 'update' : 'create',
      isSubtree,
      before: isDelete || exists ? before : undefined,
      body: c.body,
      checks,
    };
  });

  const refusals = items.flatMap((i) => i.checks.refusals.map((r) => ({ ...r, path: i.path })));
  const warnings = items.flatMap((i) => i.checks.warnings.map((w) => ({ ...w, path: i.path })));

  const proposal = {
    id: randomUUID().slice(0, 8),
    appname: ctx.appname,
    version: ctx.version ?? 'test',
    note: note ?? null,
    created_at: new Date().toISOString(),
    items,
    refusals,
    warnings,
    ok: refusals.length === 0,
    previewed: false,
    applied: false,
  };
  proposals.set(proposal.id, proposal);
  return proposal;
}

export function getProposal(id) {
  const p = proposals.get(id);
  if (!p) throw new ChangeError(`no proposal ${id}; call plan_change first`);
  return p;
}

/** Render a proposal for a human. Marks it previewed, which apply requires. */
export function preview(id) {
  const p = getProposal(id);
  p.previewed = true;
  const lines = [];
  lines.push(`proposal ${p.id} — ${p.appname} (${p.version})`);
  if (p.note) lines.push(`  ${p.note}`);
  lines.push('');
  for (const item of p.items) {
    lines.push(`  ${item.operation.toUpperCase().padEnd(6)} ${item.path}${item.label ? `   — ${item.label}` : ''}`);
    if (item.operation === 'update') {
      lines.push(`         before: ${trim(item.before)}`);
      lines.push(`         after : ${trim(item.body)}`);
    } else if (item.operation === 'create') {
      lines.push(`         value : ${trim(item.body)}`);
      if (item.isSubtree) lines.push('         (subtree — order will be reconciled after the write)');
    }
  }
  if (p.warnings.length) {
    lines.push('', '  warnings:');
    for (const w of p.warnings) lines.push(`    - ${w.path}: ${w.message}`);
  }
  if (p.refusals.length) {
    lines.push('', '  REFUSALS — apply is blocked until these are fixed:');
    for (const r of p.refusals) lines.push(`    - [${r.code}] ${r.where ?? r.path}: ${r.message}${r.fix ? `  → use ${r.fix}` : ''}`);
  } else {
    lines.push('', `  ready to apply: bubble-agent apply ${p.id}`);
  }
  return { text: lines.join('\n'), proposal: p };
}

function trim(v) {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v ?? null);
  return s.length > 180 ? `${s.slice(0, 180)}…` : s;
}

/**
 * Execute a previewed proposal.
 *
 * Order of operations matters and is not negotiable:
 *   1. refuse if the invariants flagged anything
 *   2. refuse if someone has the editor open
 *   3. capture a pre-write snapshot for revert
 *   4. write
 *   5. reconcile `order` for any subtree write
 *   6. verify against the RUNNING APP, not the export
 */
export async function apply(ctx, id, { skipEditorCheck = false, verify = true } = {}) {
  const p = getProposal(id);
  if (p.applied) throw new ChangeError(`proposal ${id} has already been applied`);
  if (!p.previewed) throw new ChangeError(`preview proposal ${id} before applying it`, { code: 'no-preview' });
  if (!p.ok) {
    throw new ChangeError(`proposal ${id} has ${p.refusals.length} refusal(s); it will not be applied`, {
      code: 'refused',
      detail: p.refusals,
    });
  }

  const report = { id, appname: p.appname, steps: [], ok: false };

  if (!skipEditorCheck) {
    const idle = await checkEditorIdle(() => changeMarker(ctx.session, p.appname, p.version));
    report.steps.push({ step: 'editor-idle', ...idle });
    if (!idle.ok) {
      throw new ChangeError(
        'the app is being edited right now; writing beside an open editor risks the editor overwriting this',
        { code: 'editor-open', detail: idle },
      );
    }
  }

  // pre-write snapshot: the only reliable source for an exact revert
  const snapshot = { export: await fetchExport(ctx.session, p.appname, p.version) };
  report.steps.push({ step: 'snapshot', bytes: JSON.stringify(snapshot.export).length });
  p.snapshot = {
    before: p.items.map((i) => {
      const value = readPath(snapshot.export, i.path, ctx.vocabulary);
      return { path: i.path, value: value === undefined ? null : value, existed: value !== undefined, operation: i.operation };
    }),
  };

  const res = await writeChanges(
    ctx.session,
    p.appname,
    p.items.map((i) => ({ path: i.path, body: i.body, before: i.before, label: i.label })),
    { version: p.version },
  );
  report.steps.push({ step: 'write', status: res.status, last_change: res.last_change ?? null });

  // Sibling order is not reliable after a subtree write, and firing the corrections
  // back-to-back is not enough: measured on a live app, six rapid writes to sibling
  // `order` landed as 3,1,2, while the same writes with a read between each landed as
  // 1,2,3. So reconciliation reads back and converges rather than assuming.
  const subtrees = p.items.filter((i) => i.isSubtree && i.body !== null);
  if (subtrees.length) {
    const recon = await reconcileOrder(ctx, subtrees, p);
    report.steps.push({ step: 'order-reconcile', ...recon });
    if (!recon.ok) {
      report.orderWarning =
        'sibling order could not be made to match the intended order; elements may render in the wrong sequence';
    }
  }

  p.applied = true;
  p.applied_at = new Date().toISOString();

  if (verify) {
    const v = await verifyProposal(ctx, p);
    report.steps.push({ step: 'verify', ...v });
    report.ok = v.ok;
    report.verification = v;
  } else {
    report.ok = true;
    report.steps.push({ step: 'verify', skipped: true, note: 'verification was disabled; the write is unconfirmed' });
  }
  return report;
}

/**
 * Make stored sibling order match intended order, and prove it.
 *
 * Writes the corrections, re-reads, and repeats on whatever is still wrong. Converges
 * in one or two passes in practice; the pass limit stops it spinning if Bubble ever
 * refuses a value outright. Returns what it did and whether it succeeded — a caller
 * that ignores this is back to assuming, which is what went wrong in the first place.
 */
export async function reconcileOrder(ctx, items, proposal, { maxPasses = 4 } = {}) {
  const wanted = [];
  for (const item of items) {
    for (const job of orderReconciliation(item.body, item.path)) wanted.push(job);
  }
  if (!wanted.length) return { ok: true, writes: 0, passes: 0 };

  let writes = 0;
  let passes = 0;
  let outstanding = wanted;
  for (; passes < maxPasses && outstanding.length; passes++) {
    for (const job of outstanding) {
      await writeChanges(ctx.session, proposal.appname, [{ path: job.path, body: job.value }], { version: proposal.version });
      writes++;
    }
    const doc = await fetchExport(ctx.session, proposal.appname, proposal.version);
    outstanding = wanted.filter((job) => readPath(doc, job.path, ctx.vocabulary) !== job.value);
  }
  return {
    ok: outstanding.length === 0,
    writes,
    passes,
    unresolved: outstanding.map((j) => j.path),
  };
}

/**
 * Read the result back out of the running app.
 *
 * Falls back to the export only when the running app is unreachable, and says so
 * loudly, because the export has confirmed broken writes before.
 */
export async function verifyProposal(ctx, proposal) {
  const targets = proposal.items.filter((i) => i.body !== null);
  if (!targets.length) return { ok: true, method: 'none', note: 'deletions only' };

  const pages = new Set();
  for (const item of targets) {
    const seg = item.path.split('.');
    if (seg[0] === '%p3' && seg[1]) pages.add(seg[1]);
  }

  let runtime = null;
  let method = 'running-app';
  const notes = [];
  try {
    const pageKey = [...pages][0];
    const pageName = ctx.doc?.pages?.[pageKey]?.name ?? '';
    runtime = await fetchRuntime(proposal.appname, {
      version: proposal.version,
      page: pageName,
      devPassword: ctx.devPassword,
      origin: ctx.runtimeOrigin,
      want: ['dynamic'],
    });
  } catch (err) {
    method = 'export-fallback';
    notes.push(`running app unreachable (${err.message}); fell back to the export, which cannot detect a dead property key`);
  }

  const results = [];
  if (method === 'running-app') {
    const text = runtime.bundles.dynamic.text;
    for (const item of targets) {
      const key = item.path.split('.').filter(Boolean).at(-1);
      const objectKey = item.isSubtree ? key : item.path.split('.').at(-3);
      const present = item.isSubtree ? hasKey(text, key) : text.includes(`"${objectKey}":{`);
      let matches = null;
      if (item.isSubtree) {
        const node = extractNode(text, key);
        matches = node ? JSON.stringify(node['%x']) === JSON.stringify(item.body['%x']) : false;
      }
      results.push({ path: item.path, present, typeMatches: matches });
    }
  } else {
    const doc = await fetchExport(ctx.session, proposal.appname, proposal.version);
    for (const item of targets) {
      results.push({ path: item.path, present: readPath(doc, item.path) !== undefined, typeMatches: null });
    }
  }

  const failed = results.filter((r) => !r.present || r.typeMatches === false);
  return {
    ok: failed.length === 0 && method === 'running-app',
    method,
    notes,
    checked: results.length,
    failed,
    results,
  };
}

/**
 * Put back exactly what was there before this proposal ran.
 *
 * Writing `null` to Bubble DELETES. So a revert that cannot prove what a path held
 * beforehand must refuse rather than guess: restoring "nothing" over a property that
 * did exist is not a revert, it is a second, quieter act of damage. Only a path that
 * genuinely did not exist before — one this proposal created — is reverted with null.
 */
export async function revert(ctx, id) {
  const p = getProposal(id);
  if (!p.applied) throw new ChangeError(`proposal ${id} was never applied`);
  if (!p.snapshot) throw new ChangeError(`proposal ${id} has no pre-write snapshot to restore from`);

  const { changes, unsafe } = planRevert(p.snapshot);
  if (unsafe.length) {
    throw new ChangeError(
      `refusing to revert ${id}: ${unsafe.length} path(s) existed before the write but their ` +
        'previous value was not captured, so reverting would delete rather than restore',
      { code: 'unsafe-revert', detail: unsafe },
    );
  }
  const res = await writeChanges(ctx.session, p.appname, changes, { version: p.version });
  p.reverted_at = new Date().toISOString();
  return {
    id,
    status: res.status,
    restored: changes.filter((c) => c.body !== null).length,
    removed: changes.filter((c) => c.body === null).length,
  };
}

/**
 * Decide what a revert would write, without writing it.
 *
 * Pure, and separate from `revert`, because this is the decision that once deleted a
 * live element: a path whose previous value was not captured must NOT be reverted with
 * `null`, since null deletes. Only a path that genuinely did not exist before — one the
 * proposal created — is undone that way.
 */
export function planRevert(snapshot) {
  const unsafe = [];
  const changes = [];
  for (const b of snapshot?.before ?? []) {
    if (b.existed && (b.value === null || b.value === undefined)) {
      unsafe.push(b.path);
      continue;
    }
    changes.push({
      path: b.path,
      body: b.existed ? b.value : null,
      label: b.existed ? 'revert: restore previous value' : 'revert: remove what was created',
    });
  }
  return { changes, unsafe };
}

/** Everything proposed this process. */
export function listProposals() {
  return [...proposals.values()].map((p) => ({
    id: p.id,
    appname: p.appname,
    note: p.note,
    items: p.items.length,
    ok: p.ok,
    previewed: p.previewed,
    applied: p.applied,
    created_at: p.created_at,
  }));
}
