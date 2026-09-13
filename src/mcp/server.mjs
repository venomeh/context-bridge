#!/usr/bin/env node
// MCP server. A thin wrapper over core — every tool here is a few lines around a
// library call, and the invariants live in core so nothing exposed can bypass them.
//
// Configure with environment variables in your MCP client config:
//   BUBBLE_APP           the app id from the editor URL (?id=…)   [required]
//   BUBBLE_DEV_PASSWORD  dev-version password, "user:pass" or "pass"  [recommended]
//   BUBBLE_VERSION       defaults to "test"
//   BUBBLE_ORIGIN        custom domain for the running app, if any

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import * as A from '../core/index.mjs';

const CONFIG = {
  appname: process.env.BUBBLE_APP || null,
  devPassword: process.env.BUBBLE_DEV_PASSWORD || undefined,
  version: process.env.BUBBLE_VERSION || 'test',
  origin: process.env.BUBBLE_ORIGIN || undefined,
};

let ctx = null;
let opening = null;

/** Open (or reuse) the app context. Re-entrant so parallel tool calls share one open. */
async function app({ refresh = false } = {}) {
  if (ctx && !refresh) return ctx;
  if (!CONFIG.appname) {
    throw new Error(
      'BUBBLE_APP is not set. Put the app id from your Bubble editor URL (?id=…) in the ' +
        'MCP server config, then restart. Run `bubble-agent setup` for a guided walkthrough.',
    );
  }
  if (!opening || refresh) {
    opening = A.openApp({
      appname: CONFIG.appname,
      version: CONFIG.version,
      devPassword: CONFIG.devPassword,
      runtimeOrigin: CONFIG.origin,
    }).then((c) => {
      ctx = c;
      opening = null;
      return c;
    }).catch((e) => {
      opening = null;
      throw e;
    });
  }
  return opening;
}

const text = (s) => ({ content: [{ type: 'text', text: typeof s === 'string' ? s : JSON.stringify(s, null, 1) }] });
const fail = (e) => ({
  content: [{ type: 'text', text: A.redact(`${e.message}${e.hint ? `\n\nhint: ${e.hint}` : ''}`) }],
  isError: true,
});
const tool = (fn) => async (args) => {
  try {
    return await fn(args);
  } catch (e) {
    return fail(e);
  }
};

const server = new McpServer({ name: 'bubble-agent', version: '1.0.0' });

// ---------------------------------------------------------------- orientation

server.tool(
  'bubble_status',
  'Session, target app, and whether the running app is reachable for verification. Call this first if anything is behaving oddly.',
  {},
  tool(async () => {
    const s = A.loadSession();
    const out = {
      session: s ? { stored_in: s.stored_in, captured_at: s.captured_at, expires_at: s.expires_at, expired: s.expired } : null,
      config: { app: CONFIG.appname, version: CONFIG.version, dev_password_set: Boolean(CONFIG.devPassword), origin: CONFIG.origin ?? null },
    };
    if (!s) {
      out.next = 'No session. Run `bubble-agent setup` in a terminal, then restart this MCP server.';
      return text(out);
    }
    if (!CONFIG.appname) {
      out.next = 'No BUBBLE_APP configured. Add it to the MCP server env and restart.';
      return text(out);
    }
    const probe = await A.probeApp(s, CONFIG.appname, CONFIG.version);
    out.app = probe;
    if (probe.ok) {
      const c = await app();
      out.runtime = { reachable: c.runtimeReachable, degraded: c.degraded };
      out.vocabulary = { coded_properties: c.vocabulary?.codedCount ?? null, element_types: Object.keys(c.vocabulary?.defaultStyles ?? {}).length };
    }
    return text(out);
  }),
);

server.tool(
  'bubble_overview',
  'Map the app: pages, element counts, workflow counts, and the element types available in this Bubble build.',
  {},
  tool(async () => {
    const c = await app();
    return text({
      ...c.summary,
      pages: A.listPages(c.doc),
      element_types: Object.keys(c.vocabulary?.defaultStyles ?? {}).sort(),
      degraded: c.degraded,
    });
  }),
);

server.tool(
  'bubble_find',
  'Find elements on a page by name, object key or element id. Returns their paths, which every other tool takes.',
  {
    page: z.string().describe('page name, object key or page element id'),
    element: z.string().optional().describe('element name (substring ok), key, or id; omit to list the whole page'),
  },
  tool(async ({ page, element }) => {
    const c = await app();
    const { page: pg, matches } = A.findElements(c.doc, page, element);
    if (!pg) return text({ error: `no page matching "${page}"`, pages: A.listPages(c.doc).map((p) => p.name) });
    return text({
      page: { name: pg.name, key: pg.key, path: pg.path, id: pg.id },
      count: matches.length,
      matches: matches.slice(0, 200).map((m) => ({ name: m.name, type: m.type, path: m.path, id: m.id, children: m.children })),
    });
  }),
);

server.tool(
  'bubble_read',
  'Read what is stored at a path. Use it to see an element\'s real properties before changing them.',
  { path: z.string().describe('dotted Bubble path, e.g. %p3.<page>.%el.<el>') },
  tool(async ({ path }) => {
    const c = await app();
    const value = A.readPath(c.doc, path, c.vocabulary);
    if (value === undefined) return text({ path, found: false, note: 'nothing at that path' });
    return text({ path, found: true, value });
  }),
);

server.tool(
  'bubble_property_key',
  'The storage key a property must be written under in THIS app\'s Bubble build. Getting this wrong is stored silently and ignored, so check before writing anything unfamiliar.',
  { name: z.string().describe('long property name, e.g. text, placeholder, padding_left') },
  tool(async ({ name }) => {
    const c = await app();
    const key = c.vocabulary.key(name);
    return text({
      name,
      storage_key: key,
      coded: key !== name,
      note: key === name
        ? 'This property is stored under its long name.'
        : `Write "${key}". Writing "${name}" would be accepted with HTTP 200 and then ignored.`,
    });
  }),
);

server.tool(
  'bubble_element_schema',
  'Which properties an element type accepts, and the default named style it gets. Answers "what does a Video actually take".',
  { type: z.string().describe('Bubble element type, e.g. Video, Link, RepeatingGroup') },
  tool(async ({ type }) => {
    const c = await app();
    const schema = c.vocabulary.schemas[type];
    return text({
      type,
      known: Boolean(schema),
      fields: schema?.fields ?? [],
      default_style: c.vocabulary.defaultStyles[type] ?? null,
      available_types: schema ? undefined : Object.keys(c.vocabulary.schemas).sort(),
    });
  }),
);

server.tool(
  'bubble_mint_ids',
  'Allocate object keys and element ids that cannot collide with ids Bubble will issue later. Use these when creating elements.',
  { count: z.number().int().min(1).max(200).default(1) },
  tool(async ({ count }) => {
    const c = await app();
    return text({ ids: A.mintIds(c.doc, { count }) });
  }),
);

// ---------------------------------------------------------------- changes

server.tool(
  'bubble_plan_change',
  'Build a change proposal. Writes NOTHING. Resolves every path, records the current value, and runs the safety checks. Always the first step of any edit.',
  {
    changes: z.array(z.object({
      path: z.string().describe('dotted Bubble path to write'),
      body: z.any().describe('the value; null deletes'),
      label: z.string().optional(),
    })).min(1),
    note: z.string().optional().describe('what this change is for'),
  },
  tool(async ({ changes, note }) => {
    const c = await app({ refresh: true });
    const p = A.propose(c, changes, { note });
    return text({
      proposal: p.id,
      ok: p.ok,
      items: p.items.map((i) => ({ path: i.path, operation: i.operation, subtree: i.isSubtree })),
      refusals: p.refusals,
      warnings: p.warnings,
      next: p.ok ? `bubble_preview_change({ id: "${p.id}" })` : 'fix the refusals and plan again',
    });
  }),
);

server.tool(
  'bubble_preview_change',
  'Show exactly what a proposal will do, before and after. Required before applying.',
  { id: z.string() },
  tool(async ({ id }) => text(A.preview(id).text)),
);

server.tool(
  'bubble_apply_change',
  'Apply a previewed proposal: checks nobody is editing, snapshots for revert, writes, reconciles sibling order, then verifies against the RUNNING app.',
  {
    id: z.string(),
    skip_editor_check: z.boolean().default(false).describe('only if you are certain nobody has the app open'),
  },
  tool(async ({ id, skip_editor_check }) => {
    const c = await app();
    const report = await A.apply(c, id, { skipEditorCheck: skip_editor_check });
    await A.reload(c);
    return text(report);
  }),
);

server.tool(
  'bubble_verify',
  'Re-read a proposal\'s paths from the running app and report whether the change really landed.',
  { id: z.string() },
  tool(async ({ id }) => {
    const c = await app({ refresh: true });
    return text(await A.verifyProposal(c, A.getProposal(id)));
  }),
);

server.tool(
  'bubble_revert_change',
  'Restore exactly what was there before a proposal was applied. Refuses if any previous value was not captured.',
  { id: z.string() },
  tool(async ({ id }) => {
    const c = await app();
    const r = await A.revert(c, id);
    await A.reload(c);
    return text(r);
  }),
);

server.tool(
  'bubble_proposals',
  'List every proposal made in this session and its state.',
  {},
  tool(async () => text(A.listProposals())),
);

server.tool(
  'bubble_refresh',
  'Re-read the app from Bubble. Call after someone edits in the editor, or if a path unexpectedly does not resolve.',
  {},
  tool(async () => {
    const c = await app({ refresh: true });
    return text({ refreshed: true, ...c.summary });
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
