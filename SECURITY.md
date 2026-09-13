# Security

## What the credential is

`bubble-agent` authenticates with your **Bubble editor session cookie**. Understand what
that is before you install anything:

- It is **full read and write access to every app on your Bubble account.** It is not
  scoped to one app, one page, or one operation.
- Bubble offers **no narrower credential.** There is no editor API key, no per-app token,
  no read-only mode. This is the only way in.
- Anything that can read the cookie can edit, or destroy, every app you own.

If that is not an acceptable risk for your account, do not install this.

## How it is handled

| | |
|---|---|
| storage | a `0600` file in a `0700` directory, by default. The macOS keychain is opt-in — see below |
| file mode | verified on every read; a file with looser permissions is refused, not fixed silently |
| command line | this tool never accepts the cookie as an argument; it is read from an interactive prompt or stdin, because argv appears in shell history and in `ps` |
| output | `redact()` runs over tool output, log lines and error stacks, including crash traces |
| transmission | every request asserts its host first; the cookie is only ever sent to `bubble.io` |
| lifetime | a TTL is stored and enforced; an expired session is refused with instructions rather than used |

### Why the keychain is not the default

`security` truncates a password read from stdin at 128 bytes, silently. A Bubble session
cookie is roughly 1,600 characters, so the safe input path cannot carry it. Storing it
intact requires passing it as a command-line argument to `security`, and an argument is
visible in `ps` for the lifetime of that call.

That is a real exposure, so it is not chosen for you. The default is the `0600` file,
which never puts the secret in an argument. If you would rather have encryption at rest
and accept the momentary exposure:

```bash
BUBBLE_AGENT_STORE=keychain node src/cli.mjs setup
```

Both positions are defensible. Neither is silent.

The dev-version password for the running app is a separate, much weaker credential. It
is used only against `*.bubbleapps.io` and is not a Bubble account credential.

## Rotating and revoking

```bash
node src/cli.mjs logout    # removes the local copy
```

That deletes what is stored here. **To invalidate the cookie itself, log out of Bubble** —
that ends the session server-side, which is the only thing an attacker who already copied
the cookie cannot work around.

Rotate if: you shared a screen while running setup, you are unsure what read your
keychain or config directory, or you are done with the tool.

## Residual risk

Installing this means trusting the tool, its dependencies and its update channel with
total control of your Bubble account. That is a real cost and no amount of care inside
this repository removes it.

What is done to keep it small:

- Two runtime dependencies (`@modelcontextprotocol/sdk`, `zod`). Keep it that way.
- No telemetry. No network calls other than to `bubble.io` and your own app's domain.
- No `eval` of anything fetched over the network. Bubble's engine bundle is *parsed* for
  its property table, never executed.

Review `src/core/session.mjs` yourself. It is short, and it is the part that matters.

## Reporting a problem

Open a security advisory on the repository rather than a public issue.

If you find something that looks like a weakness **in Bubble** rather than ordinary use
of your own credentials, report it to Bubble first and give them time to respond before
discussing it publicly.

## Scope note

This tool uses Bubble's internal editor endpoints. They are undocumented and carry no
compatibility promise. It sends your own credentials to your own account to change your
own apps — nothing here circumvents an access control or escalates a privilege. Satisfy
yourself that automated use is consistent with your agreement with Bubble before
deploying it anywhere that matters.
