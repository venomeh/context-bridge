# bubble-agent

**Repository:** https://github.com/venomeh/context-bridge

Read and change a [Bubble.io](https://bubble.io) app from Claude Code — or from plain
Node — over Bubble's own editor API, with every write verified against the running app.

```
you ──▶ Claude Code ──▶ bubble-agent (MCP) ──▶ bubble.io/appeditor  ──▶ your app
                                    └────────▶ yourapp.bubbleapps.io ──▶ verification
```

## Why the verification matters

Bubble stores some element properties under short codes (`%3` for text, `%ps` for
placeholder) and others under their long name (`padding_left`, `order`, `src`). Nothing
about a property's name tells you which it is.

Write the long name where a code belongs and Bubble answers **HTTP 200**, stores a key
the app never reads, and the JSON export renders that dead key under the same name as
the real property. Everything looks right. The app is unchanged.

So this tool reads the property table out of your app's own Bubble engine at runtime,
refuses writes that would hit that trap, and confirms every change by reading it back
out of the **running app** rather than the export.

## Requirements

- **Node 20+**
- **An app your Bubble account has editor access to.** Everything here is addressed from
  the app's JSON export, and Bubble refuses that export with a 401 for an app your account
  is not on. If you get a 401, check you are actually a collaborator on that app — adding
  yourself fixes it. `doctor` reports this clearly.

## Install

```bash
git clone https://github.com/venomeh/context-bridge.git
cd context-bridge
npm install
node src/cli.mjs setup
```

`setup` asks for three things and then writes an `.mcp.json` so Claude Code picks the
server up. Getting each one is below. Afterwards:

```bash
node src/cli.mjs doctor    # green means ready
```

Then start Claude Code **in that same folder** and ask it about your app.

## What setup asks for

Do all of this in the browser on the machine you are setting up, logged into Bubble.

### 1. The session cookie

Not one cookie — the whole `Cookie:` header, which is every cookie joined together. The
reliable way to get it:

1. Open your app in the Bubble editor
2. Press **⌥⌘I** (Mac) or **F12** to open DevTools
3. Go to the **Network** tab
4. Type `appeditor` in the filter box — this keeps only requests to Bubble itself
5. Reload the page (⌘R) so requests appear
6. Click any row in the list
7. On the right, find **Headers** → **Request Headers** → the line beginning `Cookie:`
8. Copy everything after `Cookie:`

The filter in step 4 matters. A Bubble editor page also loads Google Analytics, Stripe,
Intercom and others; those requests carry *their* cookies, not yours, and copying one of
those will not work.

What you should have: a long string, usually over a thousand characters, containing
`meta_live_u2main=` and `meta_u1main=` somewhere in it. If it is short, or has neither,
you picked a third-party request — go back to step 4.

> The DevTools **Application → Cookies** view shows the same cookies in a table, but you
> would have to reassemble them by hand. Use the Network tab.

### 2. The app id

Open the project in the Bubble editor and look at the address bar:

```
https://bubble.io/page?id=my-project-12345&tab=Design&name=index&version=test
                        └──────┬───────┘
                         this is the app id
```

It is what sits between `id=` and the next `&`. In that example, `my-project-12345`.

### 3. The dev-version password

Only if the app has one: **Settings → General → "Password to protect the dev version"**.
Leave it blank if it does not — everything still works, but changes can no longer be
verified against the running app, and the tool will say so rather than pretend.

That setting can have a **username as well as a password**. Enter both on the one line,
separated by a colon:

| the app has | type this |
|---|---|
| password `hunter2`, no username | `hunter2` |
| username `admin`, password `hunter2` | `admin:hunter2` |
| username `admin`, password `pa:ss` | `admin:pa:ss` |

Only the **first** colon separates the two, so a colon inside the password is fine.

Nothing appears as you type the cookie or the password — that is deliberate, not a
frozen prompt. Type and press Enter.

### When the cookie expires

Roughly every twelve hours. `doctor` will tell you, and you just run `setup` again with a
fresh cookie. Nothing else needs redoing.

One cookie is full read and write access to **every** Bubble app on your account, not
just the one you are setting up. Log out of Bubble to kill it instantly if you need to.

## What Claude can then do

| tool | |
|---|---|
| `bubble_status` | session, app access, whether verification is available |
| `bubble_overview` | pages, element counts, the element types this Bubble build offers |
| `bubble_find` | locate elements by name, key or id |
| `bubble_read` | what is actually stored at a path |
| `bubble_property_key` | how a property must be stored **in this app** |
| `bubble_element_schema` | which properties an element type accepts |
| `bubble_mint_ids` | ids that cannot collide with ones Bubble will issue |
| `bubble_plan_change` | build a proposal; writes nothing |
| `bubble_preview_change` | exactly what will change, before and after |
| `bubble_apply_change` | write, reconcile order, verify against the running app |
| `bubble_verify` | re-check a change independently |
| `bubble_revert_change` | restore what was there before |

Changes always go **plan → preview → apply**. Apply refuses a proposal that was never
previewed, and refuses outright if the safety checks flagged anything.

## Use it as a library

The MCP layer is thin on purpose. Everything works without it:

```js
import { openApp, propose, preview, apply, revert } from 'bubble-agent';

const app = await openApp({ appname: 'my-app-12345', devPassword: 'user:password' });

const p = propose(app, [{
  path: '%p3.<page>.%el.<element>.%p.%3',
  body: { '%e': { 0: 'Hello' }, '%x': 'TextExpression' },
  label: 'headline',
}]);

console.log(preview(p.id).text);
const report = await apply(app, p.id);   // verifies against the running app
if (!report.ok) await revert(app, p.id);
```

## What it refuses to do

Not configuration — these are enforced in the core library, so no caller can opt out.

- Write a property under a name Bubble would ignore
- Write a string carrying a literal `\n` from a bundle decoded one level short
- Write to a path whose parent does not exist
- Write while someone has the app open in the Bubble editor
- Apply a proposal that was never previewed
- Revert by writing `null` over a value it did not capture first

## Verification, honestly

Verification needs the running app. If your dev version is password protected and you
do not supply the password, `bubble_status` and `doctor` will both say so, and writes
will be reported as **unconfirmed** rather than quietly assumed to have worked.

## Security

One Bubble editor cookie is full read/write access to **every app on your account**.
Read [SECURITY.md](SECURITY.md) before installing. Short version: it is kept in a `0600`
file (the macOS keychain is opt-in, for a reason explained there), never passed as an
argument to this tool, redacted from all output, and you revoke it by logging out of
Bubble.

## Going deeper

- **[HANDOVER.md](HANDOVER.md)** — the complete specification: the protocol, the data
  model, the property code table, every failure mode with its cause, and a build order.
  Written so this can be rebuilt from nothing, by a person or a model.
- **[JOURNEY.md](JOURNEY.md)** — how it was arrived at, including the approaches that do
  not work. Worth reading first if you are extending it.
- **[SECURITY.md](SECURITY.md)** — what the credential grants and how it is handled.

## Limits

- Branches are not reachable — the export endpoint takes a version, never a branch.
- If the export is refused, nothing works — there are no ids or paths without it.
- These are Bubble's internal editor endpoints, not a published API. They are stable in
  practice but carry no compatibility promise.

## Licence

MIT.
