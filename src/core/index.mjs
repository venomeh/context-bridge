// The library. Usable with no MCP server and no model:
//
//   import { openApp, propose, preview, apply } from 'bubble-agent';
//   const app = await openApp({ appname: 'my-app-12345', devPassword: 'user:password' });
//   const p = propose(app, [{ path: '…%p.%3', body: {...} }]);
//   preview(p.id);
//   await apply(app, p.id);
//
// If the library cannot do this without the agent layer, the agent layer is hiding a
// defect rather than adding a capability.

export * from './session.mjs';
export * from './api.mjs';
export * from './runtime.mjs';
export * from './codes.mjs';
export * from './paths.mjs';
export * from './invariants.mjs';
export * from './change.mjs';

import { requireSession } from './session.mjs';
import { fetchExport } from './api.mjs';
import { fetchRuntime } from './runtime.mjs';
import { buildVocabulary } from './codes.mjs';
import { listPages } from './paths.mjs';

/**
 * Open an app: session, export, and the property vocabulary read from that app's own
 * Bubble engine.
 *
 * `devPassword` unlocks the running app when the dev version is password protected.
 * Without it the export still works, but writes can only be verified against the
 * export — which is exactly the oracle that has confirmed broken writes before. The
 * context records that degradation rather than hiding it.
 */
export async function openApp({ appname, version = 'test', devPassword, runtimeOrigin, session } = {}) {
  if (!appname) throw new Error('openApp needs an appname (the id in the editor URL)');
  const sess = session ?? requireSession();
  const doc = await fetchExport(sess, appname, version);

  const ctx = {
    session: sess,
    appname,
    version,
    devPassword,
    runtimeOrigin,
    doc,
    vocabulary: null,
    runtimeReachable: false,
    degraded: [],
  };

  try {
    const rt = await fetchRuntime(appname, {
      version,
      page: '',
      devPassword,
      origin: runtimeOrigin,
      want: ['run', 'dynamic'],
    });
    ctx.vocabulary = buildVocabulary({
      runJs: rt.bundles.run.text,
      dynamicJs: rt.bundles.dynamic?.text,
      exportDoc: doc,
    });
    ctx.runtimeReachable = true;
  } catch (err) {
    ctx.degraded.push({
      capability: 'verification and property-key checking',
      reason: err.message,
      consequence:
        'Without the running app the property code table cannot be read, so writes cannot be ' +
        'checked for the dead-key trap and cannot be verified. Supply devPassword, or a ' +
        'runtimeOrigin for a custom domain.',
    });
  }

  ctx.summary = {
    appname,
    version,
    pages: listPages(doc).length,
    elements: Object.keys(doc?._index?.id_to_path ?? {}).length,
    codedProperties: ctx.vocabulary?.codedCount ?? null,
    elementTypes: Object.keys(ctx.vocabulary?.defaultStyles ?? {}).length || null,
    runtimeReachable: ctx.runtimeReachable,
  };
  return ctx;
}

/** Re-read the export into an existing context, after a write or an outside edit. */
export async function reload(ctx) {
  ctx.doc = await fetchExport(ctx.session, ctx.appname, ctx.version);
  return ctx;
}
