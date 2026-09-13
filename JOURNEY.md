# How this was arrived at

The chronological record: what was tried, what failed, and why the design ended up where
it did. `HANDOVER.md` is the specification; this is the reasoning behind it, including
the routes that turned out to be dead ends.

Worth reading before rebuilding, because roughly half the effort went into approaches
that do not work, and none of that is discoverable from Bubble's documentation.

---

## Phase 1 — read-only (9–10 September)

**Goal:** make a Bubble app queryable at all.

Built a local MCP server that ingests a `.bubble` export into SQLite: a parser, an index,
a semantic diff engine, and 19 read tools — 29 by the end, as scoping, option sets, the
design system and a health/findings view were added.

### What the format turned out to be

A single plain JSON object. No zip, no NDJSON. Internal ids are **stable across exports**,
which is what makes diffing possible at all. Ordered lists are objects with numeric-string
keys (`"0"`, `"1"`). `settings.secure` holds real secrets, and JWTs also appear in
`client_safe` and in page-level inline JavaScript — all stripped at ingest.

### Four bugs that only independent testing caught

Each passed the implementer's own tests and was found by checking raw bytes separately:

1. **Multi-state writes.** Bubble's "set state" action can write several states in one
   step; only the first was indexed. Produced three confident "nothing writes this state"
   answers that were false.
2. **Newest-wins project resolution.** Thirteen tools asked for "the current snapshot"
   without naming an app, resolving to whichever was exported most recently. With two
   projects, every answer was about the wrong one — confidently. Now: explicit argument →
   env → launch directory → only-one-project → **refuse and list options**. No fallback.
3. **Fuzzy name matching beating exact keys.** Asking for `os_admin_panel` returned a
   different option set, because that string was also another set's display name.
4. **Silently dropped elements.** Five real named elements vanished because an id-less
   placeholder *with children* was pruned along with its subtree. "Skip the placeholder"
   and "skip its subtree" had been the same rule for the parser's whole life, because one
   app's placeholders happened to all be empty.

**The lesson that shaped everything after:** the implementer's passing tests are not
evidence. Verify independently, from raw data, or not at all.

---

## Phase 2 — dead ends (10–11 September)

### The collaborator-email approach — rejected

A commercial tool does this by adding a bot account as an app collaborator. Investigated
and set aside: it needs a seat per app, gives the same account-wide access anyway, and
adds a dependency on a third party's infrastructure.

### Browser automation for login — abandoned after real damage

The plan was to drive a headless Chromium logged into Bubble.

- **Google blocks Playwright-driven sign-in** — "This browser or app may not be secure."
  Not circumvented.
- **Chrome 136+ blocks remote debugging on the default profile.**
- Worse: an unsandboxed test **deleted the user's 61 MB logged-in Chromium profile**,
  permanently breaking the one login path that had worked, because Google's device-trust
  markers lived in it.

That incident, plus an earlier one where a test deleted a live database file, forced a
full destructive-path audit and a safety module that computes protected paths **without
reading the environment** — so a misconfigured env var cannot fool the guard that exists
because of a misconfigured env var.

**What replaced it:** paste the session cookie once. Unglamorous, and it works.

### Branches — unreachable

Five independent measurements: the export endpoint takes a *version* (`test`, `live`),
never a branch. There is no way to read a branch's contents. The write policy had assumed
all agent work would happen on an isolated branch; that assumption was deleted and
replaced with savepoints plus verification against `main`.

### Free apps — plan-gated

Deferred early, then measured properly at the end: one cookie opens the *editor* for both
a paid and a free app, but `appeditor/export` returns 200 for the paid one and **401** for
the free one. So the block is the plan, not the account. Free apps cannot be used at all.

---

## Phase 3 — the write path (11 September)

Found by experiment: `POST bubble.io/appeditor/write`, authenticated by the same cookie.
`SetData` creates as well as updates; `null` deletes; `session_id` is not validated.

Then it broke things, repeatedly, and each break taught the rule that is now enforced in
code. All of these returned **HTTP 200** and looked correct in the export:

1. **A junk property.** Wrote `placeholder` where `%ps` was required. Export confirmed it;
   the app was unchanged. Cause: generalising "long names work" from a single trial
   validated by a broken oracle.
2. **A toast fired on failed logins.** A condition tree re-encoded with a partial key map.
   An unevaluable condition does not block a step — it runs.
3. **The login broke entirely.** Same partial map, this time missing `%ei` and `%ai`.
   Repaired by extracting the original steps verbatim from a pre-damage capture and
   writing those exact bytes back — none of the reasoning that caused the break was used
   in fixing it.

**The turning point** was realising the export could not be trusted as an oracle: the
string `example@gmail.com` appeared zero times in the entire export and once in the
running app. From then on, verification meant reading the running app's `dynamic.js`.

### The property key map, twice

First derived by correlating 714 elements between export long-names and running-app
short-codes — 136 codes resolved. Correct, but laborious and incomplete.

Then, two days later and by accident while chasing an image-fit bug, the **actual table**
turned up inside Bubble's engine bundle `run.js`: one flat object, 141 entries. Not
derived — authoritative. Everything since reads it at runtime, which proved necessary
almost immediately: the same app had **142** entries two days later.

---

## Phase 4 — proving the surface (11–13 September)

Built a full dashboard on an empty page to find out what could actually be created:
71 elements covering all 25 built-in visual types, responsive to 380px, with workflows.

What that exercise established: ids are minted client-side; `_index.id_to_path` maintains
itself; a whole subtree can be written in one request, **but** the server renormalises
`order` inside it; `container_layout` cannot be changed in a conditional state; rows stack
via `flex-wrap` computed from children's `min_width_css`.

Then bound it to the app's real Supabase-backed API, which surfaced three more:

- A call that is *published as data* may still be **wired to nothing and broken**. Check
  whether the app's own pages use it before trusting it.
- A **container between a repeating group's cell and its fields severs the binding**
  unless it carries `%ds = ElementParent` and the list's type.
- A **cache-buster bound to a constant** means Bubble may serve a cached result forever.

---

## Phase 5 — packaging (13 September)

Decision: ship as an MCP server plus a skill, with a core library usable without either.

Measured first, which changed the design: the write path needs **only** the cookie and
`Content-Type`. Every `X-Bubble-*` header, including a pinned client-version hash the
earlier code sent, is decoration — so there is no coupling to a Bubble build number, and
the protocol will not rot on their next deploy.

### Five bugs found in code that had already been called "tested"

Every one was in a path written carefully but never *executed*:

1. **Revert deleted instead of restoring.** Destroyed a live element during its own test.
2. **The secret prompt masked nothing** — it wrote an empty string and set raw mode to
   *false*, which enables echo. Cookies printed in plaintext.
3. **The keychain was unusable.** `security` hex-encodes on read and truncates stdin at
   128 bytes; a Bubble cookie is ~1,600 characters.
4. **`setup` hung on non-TTY stdin.** `readline/promises` stops resolving after the second
   question on piped input.
5. **Order reconciliation raced.** Six rapid writes landed `3,1,2` and stayed wrong.

The tested paths held up. The untested ones did not — which is the whole lesson of this
project restated one more time.

---

## What would be done differently

- **Extract the code table from `run.js` on day one.** Two days of correlation work became
  obsolete the moment it was found, and the correlation could never have covered
  properties the sample apps did not use.
- **Build the invariants before the write path**, not after breaking things. Every rule
  now enforced in code was paid for with a broken live app.
- **Never test destructive operations against a real app.** Two elements were destroyed
  during development, and a user's browser profile. A throwaway app costs nothing.
- **Treat "it is written" and "it is tested" as unrelated claims.** Twelve real bugs in
  this project were found either by executing a path for the first time or by an
  independent check of raw data — none by re-reading the code that contained them.
