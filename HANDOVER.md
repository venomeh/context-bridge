# Bubble agent — complete handover

Everything needed to rebuild this from nothing, written for someone (or something) with
no prior context. Every factual claim here was measured against a live Bubble app, not
inferred from documentation — Bubble publishes none for any of this.

Written 13 September 2026.

---

## 1. The problem

A Bubble.io app is a no-code app. Its entire definition — pages, elements, workflows,
API calls, styles — lives on Bubble's servers and is editable only through their visual
editor. There is no repository, no file to read, no public API for the app's structure.

So working with an LLM on a Bubble app means a loop of: export the app as JSON by hand,
paste it into a chat, get advice back, apply the advice by hand in the editor. The model
never sees the app, cannot verify anything it suggests, and every change is manual.

**The goal:** let an agent read a Bubble app, change it, and prove the change landed.

---

## 2. The one thing that makes this hard

Bubble stores element properties under **two naming schemes at once**:

- some under short codes — `%3` is text, `%ps` is placeholder, `%bgc` is bgcolor
- the rest under their long name — `padding_left`, `order`, `src`, `video_source`

Nothing about a property's name tells you which scheme applies. And the failure is
silent in the worst possible way:

> Write the long name where a code belongs and Bubble returns **HTTP 200**, stores a key
> the app never reads, and the JSON export renders that dead key under *the same name* as
> the real property. Everything looks correct. The app is unchanged.

Measured: after writing `placeholder` instead of `%ps`, the string `example@gmail.com`
appeared **zero** times in the entire export and exactly **once** in the running app.

This single fact drives the whole architecture. Almost every rule below exists because
of it.

---

## 3. Access

### 3.1 The credential

One **Bubble editor session cookie**, taken from a browser logged into Bubble.

- It is **account-scoped, not app-scoped** — full read/write to every app on the account.
  Verified: one cookie opened the editor for two different apps.
- Bubble offers no narrower credential. No API key, no per-app token, no read-only mode.
- Rotate by logging out of Bubble, which ends the session server-side.

### 3.2 Reading the app

```
GET https://bubble.io/appeditor/export/<version>/<app>.bubble
Cookie: <session cookie>
```

Returns the entire app as one JSON object (1.76 MB / 9 pages for the test app).
`<version>` is `test` or `live` — **never a branch**; branches are unreachable through
this endpoint, confirmed by five independent measurements.

**Requires a paid Bubble plan.** A free app returns 401. Without the export there are no
ids and no paths, so free apps cannot be used at all. This defines the audience.

### 3.3 Writing

```
POST https://bubble.io/appeditor/write
Cookie: <session cookie>
Content-Type: application/json

{ "v": 1, "appname": "<app>", "app_version": "test",
  "changes": [{
    "body": <value>,                    // null DELETES
    "path_array": ["%p3","<page>","%el","<el>","%p","<propcode>"],
    "intent": { "name": "SetData", "id": 3, "source_appname": "" },
    "version_control_api_version": 5,
    "changelog_data": [{ operation, before_value, after_value, display_name,
                         type, root, change_identifier, change_path,
                         inner_nodes_info, inner_node_count }],
    "session_id": "<anything>"
  }]
}
→ 200 { "last_change", "last_change_date", "id_counter" }
```

Measured properties of this endpoint:

- **Only the cookie and `Content-Type` are required.** Every `X-Bubble-*` header —
  including a pinned client-version commit hash that earlier code sent — is decoration.
  This matters: it means the write path has no coupling to a Bubble build number and
  will not rot when they deploy.
- **`session_id` is not validated.** Any value is accepted. No live editor session needed.
- **`SetData` creates as well as updates.** Writing to a path that does not exist creates
  it — a property, an element, a whole workflow.
- **`null` deletes.** There is no separate delete call.

### 3.4 The running app — the only honest oracle

```
https://<app>.bubbleapps.io/version-<version>/<page>
```

Behind HTTP basic auth if the dev version is password protected (Settings → General).
The page's HTML references three bundles:

| bundle | contains |
|---|---|
| `/package/static_js/…/static.js` | styles, some settings |
| `/package/dynamic_js/…/dynamic.js` | **the page tree in stored, short-coded form**, plus app settings |
| `/package/run_js/…/run.js` | **Bubble's engine** — the property code table and per-type schemas |

The export renders codes into long names, one way and lossily, so it **cannot** verify a
write. The running app holds what is actually stored. Address with the export; verify
here. The export confirmed three broken writes in a row before a human looked at the app.

---

## 4. The data model

### 4.1 Two id namespaces

Every object has **both**:

- an **object key** — its slot in the parent (`bTLLc0`)
- an **`id` field** — its global identity (`bTLLb0`)

They differ. Paths are built from object keys. References between objects (`%ei`
element_id, `%ai` action_id) use the `id` field. Confusing them addresses nothing.

`_index.id_to_path` maps id → path and **Bubble maintains it itself** — writing an
element adds the entry, including for every descendant of a subtree write; deleting
removes it. This was expected to be the hardest part and turned out to need no work.

### 4.2 Path notation

```
%p3.<page>                                  a page
%p3.<page>.%el.<el>                         an element
%p3.<page>.%el.<el>.%p.<key>                a property
%p3.<page>.%el.<el>.%s.<n>                  a conditional state
%p3.<page>.%wf.<wf>                         a workflow
%p3.<page>.%wf.<wf>.actions.<n>             a workflow step
%ed.<def>                                   a reusable element definition
settings.client_safe.apiconnector2.<group>.calls.<call>.<field>
```

Segment meanings: `%p3` pages, `%el` elements, `%p` properties, `%wf` workflows,
`%s` states, `%ed` element_definitions.

The export renders these long: `pages`, `elements`, `properties`, `workflows`. So reading
`…%p.%3` off an export finds **nothing** unless you translate `%3` → `text` first. This
caused a destructive bug — see §8.1.

### 4.3 An element node

```json
{
  "%p":  { ...properties... },
  "%s":  { "0": { "%c": <condition>, "%p": {...}, "%x": "State" } },
  "%x":  "Text",
  "id":  "bTZi001",
  "%dn": "Text A",          // default name, as the editor shows it
  "%nm": "txt: headline",   // the name the developer gave it
  "%s1": "Text_body_16_",   // named style
  "%el": { "<childKey>": { ...child node... } }
}
```

### 4.4 Expression trees

Property values are often expression trees with their own vocabulary:

```
%x type   %n next   %nm name   %p properties   %e entries
%a args   %c condition   %ei element_id   %ai action_id
```

`id`, `actions`, `custom_state`, `is_slidable` stay long. Treating a map derived for one
layer as valid for another broke a live login — see §8.2.

---

## 5. The property code table — how to get it right

**Do not derive it. Do not vendor it. Extract it at runtime.**

It ships inside `run.js` as one flat object of `long_name:"code"` pairs. Locate it by
searching for a known-stable pair, e.g. `stretch_or_rescale:"2f"` or `data_source:"ds"`,
then take the enclosing `{…}` and regex out `identifier:"code"` pairs. **Never `eval`** —
it is code fetched over the network, and the values are simple strings.

```js
storageKey(name) = table[name] ? '%' + table[name] : name
```

A property is short-coded **if and only if** its long name appears in the table.
Everything else uses its long name.

**Why runtime extraction is not optional:** a snapshot taken on 11 September had 141
entries; the same app on 13 September had **142** — `redirects → %rd` had appeared. A
vendored table is stale within days, and being stale reintroduces exactly the silent
dead-key failure it exists to prevent.

The same bundle carries `make_element("<Type>", { … field_names: {…} })` for every
element type — the schema of what properties a type accepts. A `Video` takes
`video_source` and `video_id`, never a bare URL.

App settings, in `dynamic.js` not `run.js`, carry `default_styles`: all 25 built-in
visual types and the named style each gets by default. Attaching that style is what lets
a created element inherit the app's real design tokens instead of invented values.

### 5.1 Element type names differ from the palette

| palette | internal |
|---|---|
| Searchbox | `AutocompleteDropdown` |
| File Uploader | `FileInput` |
| Map | `GoogleMap` |
| Picture Uploader | `PictureInput` |
| Group Focus | `GroupFocus` |

The 25 built-in visual types: Alert, AutocompleteDropdown, Button, Checkbox, DateInput,
Dropdown, FileInput, FloatingGroup, GoogleMap, Group, GroupFocus, HTML, Icon, Image,
Input, Link, MultiLineInput, PictureInput, Popup, RadioButtons, RepeatingGroup, Shape,
SliderInput, Text, Video.

---

## 6. Creating things

### 6.1 Elements

- **Ids are minted client-side.** Any unique string in the existing format is accepted;
  the server does not allocate them. Bubble issues ids in ascending blocks, so choose a
  prefix far ahead of the app's frontier (this account was in `bTL*`, so `bTZ*` is safe).
- Parents before children. Children nest under `%el`, keyed by object key.
- Attach `%s1` from `default_styles` for the type — free correct styling.
- Value shapes differ by type: a **Text**'s `%3` is `{"%e":{"0":"…"},"%x":"TextExpression"}`;
  a **Link**'s `%3` must be a **plain string** — an expression there renders empty.

### 6.2 Workflows

```json
// button click
{"%p":{"%ei":"<button id>"},"%x":"ButtonClicked","id":"<wf id>",
 "actions":{"0":{"%p":{"%ei":"<target id>"},"%x":"ShowElement","id":"<action id>"}}}

// page load
{"%x":"PageLoaded","id":"<id>","actions":{...}}

// navigate — %ei is the DESTINATION PAGE's id field
{"%p":{"%ei":"<page element id>"},"%x":"ChangePage","id":"<id>"}

// trigger a reusable's custom event
{"%p":{"%ei":"<reusable instance id>","custom_event":"<event id>"},
 "%x":"TriggerCustomEventFromReusable","id":"<id>"}

// set a custom state
{"%p":{"%v":<expression>,"%ei":"<element id>","custom_state":"custom.number_"},
 "%x":"SetCustomState","id":"<id>"}
```

Steps run in **numeric key order**. A `ChangePage` **ends the workflow** — anything after
it never runs. Fractional keys like `13_5` are accepted but sort last, so inserting
mid-flow means renumbering, which is a multi-write operation.

### 6.3 Binding to live data

Bubble's API Connector is under `settings.client_safe.apiconnector2.<group>.calls.<call>`.
A call is usable as a data source only if `publish_as === "data"`; `"action"` calls can
only be workflow steps.

```json
// a repeating group's data source
{"%x":"GetDataFromAPI",
 "%n":{"%x":"Message","%nm":"_api_c2_body"},
 "%p":{"provider":"apiconnector2.<group>.<call>",
       "url_params_<name>":  <expression>,
       "body_params_<name>": <expression>,
       "headers_Authorization": {"%e":{"0":"Bearer ","1":<token expression>,"2":""},
                                 "%x":"TextExpression"}}}

// and its type of content
"%gt": "api.apiconnector2.<group>.<call>.body"

// a field of the current cell
{"%x":"ElementParent","%n":{"%x":"Message","%nm":"_api_c2_<field>"}}

// a count
… "%n":{"%n":{"%x":"Message","%nm":"count"},"%nm":"_api_c2_body"} …

// dynamic choices on a dropdown / autocomplete
"choices_style": "dynamic",
"dynamic_type": "api.apiconnector2.<group>.<call>.body",
"%ds": <GetDataFromAPI as above>,
"option_display_expression": {"%e":{"0":"","1":{"%x":"InjectedValue",
  "%n":{"%x":"Message","%nm":"_api_c2_<field>"}},"2":""},"%x":"TextExpression"}
```

Field names come from each call's stored `types` blob as `_api_c2_<caption>`. **Read
them; do not guess.**

**Authentication.** If the backend requires a user token, the app almost certainly has a
reusable element holding it (this one had `AuthGuard`, token in custom state `text_`,
loaded from `localStorage` by a JS element, exposed via a "Load Session" custom event).
A page that wants live data must instantiate that reusable and trigger its load event on
page load. A consequence: the page then redirects to login when unauthenticated, exactly
like the app's own protected pages.

**Check the call is actually used somewhere before binding to it.** One call looked
perfect by name and field list and returned nothing, because it was defined and wired to
nothing — never exercised, quietly broken. *Published as data* does not mean *works*.

---

## 7. Layout and responsiveness

- **`container_layout` cannot be changed in a conditional state.** Proven by putting a
  background colour and `container_layout` in the same breakpoint state: the colour
  applied at 380px, the layout did not.
- Rows stack because **Bubble computes `flex-wrap` from the children's `min_width_css`**.
  Children at `0px` never wrap, however narrow the screen.
- A **percentage width only aligns with another element's if both resolve against
  provably equal containers.** Matching percentages on two rows is not enough — a header
  row in a flex column and a cell row inside a repeating group's grid resolved against
  different widths and drifted. The fix was `min_width_css: 100%` on both.
- **A container between a repeating group's cell and the fields reading from it severs
  the binding** unless it carries `%ds = {"%x":"ElementParent"}` and the list's `%gt`.
  Rows come back blank with no error.
- **A property owned by a named style is inert when set inline.** The write succeeds and
  nothing changes.
- **Bubble's Alert element does not render on page load** even with `is_visible` true. It
  is transient, shown by a workflow action.

---

## 8. Every failure mode, with its cause

All of these returned HTTP 200 and looked correct in the export.

### 8.1 Revert deleted instead of restoring *(destructive)*
The write API addresses `%3`; the export renders it `text`. Path resolution returned
undefined → the operation was misclassified as a *create* → revert wrote `null` → Bubble
deleted a live element.
**Rules:** translate coded segments when reading an export. And never revert by writing
`null` over a path whose previous value was not captured.

### 8.2 Partial key map broke a live login
A condition tree was re-encoded using a seven-key map that omitted `%ei` and `%ai`.
References became unresolvable; logins stopped routing. An unevaluable condition does not
block a step — **it runs**.
**Rule:** enumerate every key in a structure before transforming it and fail on the first
unmapped one. Better: copy verified bytes.

### 8.3 The escaping trap in "copy verified bytes"
A page bundle is JavaScript handing a **JSON string** to `JSON.parse`, so a newline in a
value is written `\\n`. Slicing the bundle and parsing once decodes one level and yields
a literal backslash-n. Writing that back turned three four-line dropdowns into one
unusable option each.
**Rule:** extracting from a bundle is not byte-copying. Scan every string in a moved
subtree for `\\[nrt"\\]`.

### 8.4 Sibling `order` races
A subtree write renormalises `order` on nested nodes. Single-property writes fix it — but
only if not fired back to back. Six corrections sent with no gap landed `3,1,2` and
stayed wrong across 7.5 seconds; the same six with a read between each landed `1,2,3`.
**Rule:** reconciliation must **converge** — write, re-read, re-write what is still
wrong, under a pass limit. Two passes in practice.

### 8.5 A correct write leaving the app inconsistent
Renaming an API call updates `calls.<id>.name`, but each call also carries a `types` blob
containing its own `caption` with the same name. One logical value, two storage locations.
**Rule:** know which values are duplicated, and write every copy or refuse and say so.

### 8.6 Placement
A toast appended after `ChangePage` never ran, because navigation ends the workflow.

### 8.7 The editor overwrites you
Bubble's editor holds a stale in-memory copy and autosaves.
**Rule:** refuse to write while the app is open. Detect it by sampling `last_change`
twice with no write between.

---

## 9. The tool that was built

```
bubble-agent/
├── src/core/          library — no MCP, no model
│   ├── session.mjs    credential storage, redaction, host assertion
│   ├── api.mjs        export + write endpoints
│   ├── runtime.mjs    running-app bundle fetch, node extraction
│   ├── codes.mjs      code table + per-type schemas + default styles
│   ├── paths.mjs      addressing, search, id minting
│   ├── invariants.mjs the refusals
│   ├── change.mjs     propose → preview → apply → verify → revert
│   └── index.mjs      openApp()
├── src/mcp/server.mjs 14 MCP tools, thin wrapper over core
├── src/cli.mjs        setup, doctor, status, apps, logout, mcp-config
├── skill/SKILL.md     the method, for the agent
└── test/              29 tests, synthetic fixtures, no network
```

~2,300 lines, two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`), no build
step. Core must be usable without MCP; if it is not, the agent layer is hiding a defect.

### 9.1 The write contract

`plan → preview → apply`, enforced in core so no caller can opt out. Apply refuses a
proposal that was never previewed. Its order of operations is not negotiable:

1. refuse if the invariants flagged anything
2. refuse if someone has the editor open
3. snapshot for revert
4. write
5. reconcile `order` **to convergence** for any subtree write
6. verify against the **running app**, not the export

### 9.2 Non-negotiable refusals

| code | prevents |
|---|---|
| `long-name-for-coded-property` | the silent dead-key write |
| `unknown-code` | a code that does not exist in this Bubble build |
| `escape-damage` | double-escaped strings from a bundle copy |
| `missing-parent` | an orphan at a path to nowhere |
| `editor-open` | the editor autosaving over the change |
| `unsafe-revert` | a revert deleting instead of restoring |

### 9.3 Credentials

One cookie is total account access, so: a `0600` file in a `0700` directory by default,
mode verified on read; redaction over all output including crash traces; host asserted
before the cookie is attached; a TTL enforced.

The macOS keychain is **opt-in, not default**, for a measured reason: `security`
truncates a stdin password at 128 bytes silently, and a Bubble cookie is ~1,600
characters, so storing it intact requires passing it as an argv element — visible in
`ps`. Both positions are defensible; neither should be silent.

---

## 10. What is verified, and what is not

**Verified against a live paid app:** code table extraction (142 live entries, all 141
snapshot entries reproduced); 39 element schemas; 25 default styles; four write shapes
(single property, single element, 3-child subtree, multi-change); order convergence;
revert both directions; verification via the running app plus an independent second
check; all 14 MCP tools over stdio; every CLI command with correct exit codes; both
storage backends; the 401 path; the degraded no-dev-password path; 29 unit tests.

**Not verified:**

- Interactive TTY setup. Two real bugs were found and fixed there (the cookie echoed in
  plaintext; stdin closing produced a raw stack trace), but a pty fed by a pipe fights
  the test as much as the code. **The scripted path is fully verified** and is the safe
  fallback: `printf 'y\n<cookie>\n<app>\n<devpw>\ny\n' | node src/cli.mjs setup`.
- **n = 1.** One app, one account, one plan, one Bubble version. "Works on any paid app"
  is an extrapolation.
- Windows and Linux. File-mode checks and the keychain-absent branch are macOS-only so far.
- **Workflows through this tool.** Proven through the earlier bridge, never through
  `bubble-agent`. Only element properties and element trees are proven here.
- Custom domains (`BUBBLE_ORIGIN`), `live` version, concurrent tool calls, timeouts and
  retries (there are none), registry install, and whether Claude Code loads the skill.

---

## 11. If you are rebuilding this

Order matters; each step is useless without the one before it.

1. **Export + session.** Prove you can read one app with a cookie. Nothing else works
   until addressing works.
2. **Runtime fetch.** Get `run.js` and `dynamic.js` from the running app. Without these
   there is no verification and no code table, and the tool is guessing.
3. **Code table extraction.** From `run.js`, at runtime. Test it by reproducing a known
   table exactly. This is the single highest-value component.
4. **Addressing.** Paths, search, id minting — and make `readPath` vocabulary-aware from
   the start, or §8.1 will happen to you.
5. **Invariants.** Before any write path exists, so writes cannot be built without them.
6. **propose / preview / apply**, with convergent order reconciliation and running-app
   verification.
7. **Revert**, with the unsafe-revert guard.
8. **MCP + skill**, last. They are thin by design.

Test against a throwaway app, not a real one. Two elements were destroyed during this
project's development — one by a revert bug, one by an earlier unsandboxed test.

**The discipline that matters more than any of the code:** the export will tell you your
write worked. It is wrong. Read the running app.
