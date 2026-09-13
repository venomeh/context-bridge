#!/usr/bin/env node
// bubble-agent <setup|doctor|status|apps|logout|mcp-config>
//
// The cookie is only ever read from an interactive prompt or stdin. It is never a
// command-line argument, because argv lands in shell history and in `ps`.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout, argv, env, exit } from 'node:process';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  saveSession, loadSession, clearSession, SESSION_FILE, redact,
} from './core/session.mjs';
import { probeApp } from './core/api.mjs';
import { openApp } from './core/index.mjs';

const B = (s) => `\x1b[1m${s}\x1b[0m`;
const DIM = (s) => `\x1b[2m${s}\x1b[0m`;
const OK = (s) => `\x1b[32m${s}\x1b[0m`;
const BAD = (s) => `\x1b[31m${s}\x1b[0m`;
const WARN = (s) => `\x1b[33m${s}\x1b[0m`;

/**
 * Answers queued from a non-TTY stdin.
 *
 * `readline/promises` stops resolving questions once piped input hits EOF — the third
 * `question()` never settles and the process exits on an unsettled await, with no error
 * a user could act on. So when stdin is not a terminal, every line is read up front and
 * the prompts are served from that queue. Setup then works under `printf | setup`, in
 * CI, and in tests, instead of hanging.
 */
let piped = null;
async function readAllStdin() {
  const chunks = [];
  for await (const c of stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').split('\n');
}

/**
 * Read a secret without echoing it.
 *
 * Overriding readline's `_writeToOutput` is NOT enough, and shipping that would have
 * printed people's cookies: the terminal's line discipline echoes typed characters
 * itself, before readline ever sees them. Suppressing that means taking the terminal
 * out of cooked mode and handling the keystrokes here.
 *
 * Raw mode also means handling the keys the line discipline used to: Enter ends the
 * line, Ctrl-C aborts, backspace deletes.
 */
function askSecret(q) {
  return new Promise((resolve, reject) => {
    stdout.write(q);
    let value = '';
    const done = (err) => {
      stdin.setRawMode?.(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (buf) => {
      for (const ch of buf.toString('utf8')) {
        switch (ch) {
          case '\r':
          case '\n':
            return done();
          case '':
            return done(new Error('cancelled'));
          case '':
          case '\b':
            if (value.length) {
              value = value.slice(0, -1);
              stdout.write('\b \b');
            }
            break;
          default:
            if (ch >= ' ') {
              value += ch;
              stdout.write('*');
            }
        }
      }
      return undefined;
    };
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on('data', onData);
  });
}

class Abort extends Error {}

/** Prompt for input. With `secret`, nothing typed or pasted is echoed. */
async function ask(rl, q, { secret = false } = {}) {
  if (piped) {
    if (!piped.length) throw new Abort('input ended before setup finished');
    const line = piped.shift();
    stdout.write(`${q}${secret ? '*'.repeat(Math.min(line.length, 8)) : line}\n`);
    return line.trim();
  }
  if (secret && stdin.isTTY) {
    // readline is also listening on stdin; it must let go of the keystrokes first
    rl.pause();
    try {
      return await askSecret(q);
    } finally {
      rl.resume();
    }
  }
  try {
    return (await rl.question(q)).trim();
  } catch (err) {
    // stdin closed (Ctrl-D, or a pipe running dry). readline reports this as
    // ERR_USE_AFTER_CLOSE with a stack trace, which is not a useful thing to show.
    if (err?.code === 'ERR_USE_AFTER_CLOSE' || err?.code === 'ABORT_ERR') {
      throw new Abort('input ended before setup finished');
    }
    throw err;
  }
}

// ------------------------------------------------------------------ setup

async function setup() {
  if (!stdin.isTTY) piped = await readAllStdin();
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`\n${B('bubble-agent setup')}\n`);
    console.log('This connects Claude Code to a Bubble app you own.\n');

    console.log(B('Before you paste anything, know what it grants.'));
    console.log(
      '  A Bubble editor session cookie is full read and write access to EVERY app on\n' +
      '  your account. It is not scoped to one app. Bubble offers no narrower credential.\n' +
      `  It is stored in ${SESSION_FILE}\n` +
      '  with mode 0600, in a 0700 directory. The macOS keychain is available instead via\n' +
      '  BUBBLE_AGENT_STORE=keychain — SECURITY.md explains why it is not the default.\n' +
      '  Revoke at any time by logging out of Bubble, which ends the session server-side.\n',
    );
    const go = await ask(rl, 'Continue? [y/N] ');
    if (!/^y/i.test(go)) {
      console.log('Nothing was stored.');
      return;
    }

    console.log(`\n${B('Step 1 — the session cookie')}`);
    console.log(DIM('  In Chrome, open your Bubble editor, then DevTools → Application →'));
    console.log(DIM('  Cookies → https://bubble.io. Copy the whole cookie string.'));
    console.log(DIM('  (DevTools → Network → any request → Request Headers → Cookie also works.)'));
    const cookie = await ask(rl, '\n  paste cookie: ', { secret: true });
    if (!cookie || cookie.length < 20) {
      console.log(BAD('\n  That does not look like a cookie. Nothing was stored.'));
      return;
    }
    const session = saveSession({ cookie });
    console.log(OK(`  stored in ${session.stored_in}`));

    console.log(`\n${B('Step 2 — which app')}`);
    console.log(DIM('  Open the app in the Bubble editor. The id is in the URL: ?id=<this>'));
    const appname = await ask(rl, '\n  app id: ');
    if (!appname) {
      console.log(BAD('  No app id. Setup stopped; the session is still stored.'));
      return;
    }
    process.stdout.write('  checking access… ');
    const probe = await probeApp(session, appname);
    if (!probe.ok) {
      console.log(BAD('failed'));
      console.log(`  ${probe.reason}`);
      if (probe.hint) console.log(DIM(`  ${probe.hint}`));
      return;
    }
    console.log(OK(`ok — ${probe.pages} pages`));

    console.log(`\n${B('Step 3 — the running app (recommended)')}`);
    console.log(DIM('  Writes are verified by reading the running app back, because Bubble\'s'));
    console.log(DIM('  export cannot show a write that silently did nothing. If your dev version'));
    console.log(DIM('  is password protected, give that password so verification can work.'));
    console.log(DIM('  Settings → General → "Password to protect the dev version".'));
    const devPassword = await ask(rl, '\n  dev password (blank if none): ', { secret: true });

    process.stdout.write('  opening the app… ');
    let ctx;
    try {
      ctx = await openApp({ appname, devPassword: devPassword || undefined, session });
      console.log(OK('ok'));
    } catch (e) {
      console.log(BAD('failed'));
      console.log(`  ${redact(e.message, session)}`);
      return;
    }
    if (!ctx.runtimeReachable) {
      console.log(WARN('  the running app was not reachable:'));
      for (const d of ctx.degraded) console.log(DIM(`    ${d.reason}`));
      console.log(WARN('  writes will work but cannot be fully verified.'));
    } else {
      console.log(`  ${OK('verification available')} — ${ctx.vocabulary.codedCount} coded properties, ` +
        `${Object.keys(ctx.vocabulary.defaultStyles).length} element types`);
    }

    console.log(`\n${B('Step 4 — connect it to Claude Code')}`);
    const cfg = mcpConfig({ appname, devPassword: devPassword || undefined });
    const where = await ask(rl, '\n  write .mcp.json into the current directory? [Y/n] ');
    if (!/^n/i.test(where)) {
      const target = resolve('.mcp.json');
      let merged = { mcpServers: {} };
      if (existsSync(target)) {
        try {
          merged = JSON.parse(readFileSync(target, 'utf8'));
          merged.mcpServers ??= {};
        } catch {
          console.log(WARN('  existing .mcp.json is not valid JSON; writing a fresh one'));
        }
      }
      merged.mcpServers['bubble-agent'] = cfg.mcpServers['bubble-agent'];
      writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`);
      console.log(OK(`  wrote ${target}`));
    } else {
      console.log('\n  add this to your MCP config yourself:\n');
      console.log(JSON.stringify(cfg, null, 2));
    }

    console.log(`\n${OK('Done.')} Restart Claude Code in this directory and ask it about your app.`);
    console.log(DIM('  Try: "give me an overview of the app" or "find the login button".\n'));
  } catch (err) {
    if (err instanceof Abort) {
      console.log(BAD(`\n  ${err.message}`));
      console.log(DIM('  Nothing further was written. Re-run: bubble-agent setup'));
      console.log(DIM('  To script it, feed the answers in order on stdin:'));
      console.log(DIM("    printf 'y\\n<cookie>\\n<app-id>\\n<dev-password>\\ny\\n' | bubble-agent setup"));
      return 1;
    }
    throw err;
  } finally {
    rl.close();
  }
}

function mcpConfig({ appname, devPassword, version }) {
  const entry = {
    type: 'stdio',
    command: 'node',
    // fileURLToPath, not .pathname: on Windows .pathname yields "/C:/…", which node
    // cannot execute. This string ends up in someone else's MCP config.
    args: [fileURLToPath(new URL('./mcp/server.mjs', import.meta.url))],
    env: { BUBBLE_APP: appname },
  };
  if (devPassword) entry.env.BUBBLE_DEV_PASSWORD = devPassword;
  if (version && version !== 'test') entry.env.BUBBLE_VERSION = version;
  return { mcpServers: { 'bubble-agent': entry } };
}

// ------------------------------------------------------------------ doctor

async function doctor() {
  console.log(`\n${B('bubble-agent doctor')}\n`);
  let bad = 0;

  const nodeOk = Number(process.versions.node.split('.')[0]) >= 20;
  console.log(`  node ${process.versions.node}  ${nodeOk ? OK('ok') : BAD('needs >= 20')}`);
  if (!nodeOk) bad++;

  const s = loadSession();
  if (!s) {
    console.log(`  session          ${BAD('none')} — run: bubble-agent setup`);
    bad++;
  } else if (s.expired) {
    console.log(`  session          ${BAD('expired')} (${s.expires_at}) — run: bubble-agent setup`);
    bad++;
  } else {
    console.log(`  session          ${OK('present')} in ${s.stored_in}, valid until ${s.expires_at}`);
  }

  const appname = env.BUBBLE_APP;
  if (!appname) {
    console.log(`  BUBBLE_APP       ${WARN('not set')} — set it in your MCP config, or pass one to the library`);
  } else if (s && !s.expired) {
    const probe = await probeApp(s, appname, env.BUBBLE_VERSION || 'test');
    if (probe.ok) {
      console.log(`  app ${appname}  ${OK('reachable')} — ${probe.pages} pages, ${(probe.bytes / 1048576).toFixed(2)} MB`);
      try {
        const ctx = await openApp({
          appname,
          devPassword: env.BUBBLE_DEV_PASSWORD,
          version: env.BUBBLE_VERSION || 'test',
          runtimeOrigin: env.BUBBLE_ORIGIN,
          session: s,
        });
        if (ctx.runtimeReachable) {
          console.log(`  running app      ${OK('reachable')} — verification is available`);
          console.log(`  vocabulary       ${OK(`${ctx.vocabulary.codedCount} coded properties`)}, ` +
            `${Object.keys(ctx.vocabulary.defaultStyles).length} element types`);
        } else {
          console.log(`  running app      ${WARN('unreachable')} — writes cannot be verified`);
          for (const d of ctx.degraded) console.log(DIM(`                   ${d.reason}`));
          bad++;
        }
      } catch (e) {
        console.log(`  running app      ${BAD('error')} ${redact(e.message, s)}`);
        bad++;
      }
    } else {
      console.log(`  app ${appname}  ${BAD('unreachable')} — ${probe.reason}`);
      if (probe.hint) console.log(DIM(`                   ${probe.hint}`));
      bad++;
    }
  }

  console.log(`\n  ${bad === 0 ? OK('everything checks out') : BAD(`${bad} problem(s) above`)}\n`);
  return bad === 0 ? 0 : 1;
}

// ------------------------------------------------------------------ misc

async function status() {
  const s = loadSession();
  console.log(JSON.stringify({
    session: s ? { stored_in: s.stored_in, captured_at: s.captured_at, expires_at: s.expires_at, expired: s.expired } : null,
    app: env.BUBBLE_APP ?? null,
    version: env.BUBBLE_VERSION ?? 'test',
  }, null, 2));
}

async function apps() {
  const s = loadSession();
  if (!s) return console.log('no session; run: bubble-agent setup');
  const ids = argv.slice(3);
  if (!ids.length) {
    console.log('usage: bubble-agent apps <app-id> [app-id…]');
    console.log(DIM('Bubble has no endpoint that lists your apps, so check ids one at a time.'));
    console.log(DIM('An id is the ?id=… value in the editor URL.'));
    return;
  }
  for (const id of ids) {
    const p = await probeApp(s, id);
    console.log(p.ok ? `  ${OK('ok  ')} ${id}  ${p.pages} pages` : `  ${BAD('no  ')} ${id}  ${p.reason}`);
  }
}

function logout() {
  const removed = clearSession();
  console.log(removed.length ? `removed from: ${removed.join(', ')}` : 'nothing stored');
  console.log(DIM('This deletes the local copy. To invalidate the cookie itself, log out of Bubble.'));
}

function printMcpConfig() {
  console.log(JSON.stringify(mcpConfig({
    appname: env.BUBBLE_APP || '<your-app-id>',
    devPassword: env.BUBBLE_DEV_PASSWORD,
    version: env.BUBBLE_VERSION,
  }), null, 2));
}

const commands = { setup, doctor, status, apps, logout, 'mcp-config': printMcpConfig };
const cmd = argv[2] ?? 'doctor';
if (!commands[cmd]) {
  console.log(`usage: bubble-agent <${Object.keys(commands).join('|')}>`);
  exit(1);
}
const code = await commands[cmd]();
exit(typeof code === 'number' ? code : 0);
