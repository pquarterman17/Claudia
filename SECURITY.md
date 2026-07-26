# Security

Claudia launches Claude Code sessions, which read and write files and run
commands on your machine. Anything that can send it a message can do those
things. That makes the trust boundary worth stating plainly.

## Threat model

**Claudia trusts you and the software already running as you.** It does not try
to defend against a program on your own machine that runs with your privileges —
such a program can already read your files and run commands without going
through Claudia, so a password or token here would be ceremony rather than
protection.

**Claudia does not trust the web.** A page you happen to have open in another
tab must not be able to reach it. This is the real threat: it is ordinary for a
browser to have both Claudia and an untrusted page loaded at once.

## What protects the server

Claudia listens on `127.0.0.1` only, and binding to loopback is **not** by itself
an access control — two well-known attacks get past it, and both are handled
explicitly in [`server/src/origin-guard.ts`](server/src/origin-guard.ts).

| Attack | Why loopback doesn't stop it | Defence |
| --- | --- | --- |
| **Cross-origin WebSocket** | Browsers do not apply the same-origin policy to WebSockets — no preflight, no CORS. Any page can open `ws://127.0.0.1:4317`. | The `Origin` header must be a loopback host, or the upgrade is refused with 401. |
| **DNS rebinding** | The attacker points their domain at `127.0.0.1`, so the browser treats their page as same-origin with Claudia. | The `Host` header must be a loopback literal, or the request is refused with 403 before any handler runs. |

Both are covered by unit tests in
[`server/test/origin-guard.test.ts`](server/test/origin-guard.test.ts), including
the sandboxed-iframe `Origin: null` case.

Other properties that are deliberate rather than incidental:

- **No shell string interpolation.** Every subprocess — the folder picker, and
  the finish actions including shutdown — goes through `execFile` with an
  argument array, so a directory name can never become a command.
- **No `eval`, no `new Function`, no string-argument timers**, anywhere.
- **Static files cannot escape the build directory**; crafted paths get a 403.
- **No secrets are stored.** Claudia has no API key of its own — it uses the
  Claude Code credentials already on the machine. `~/.claudia/settings.json`
  holds preferences only.
- **No outbound network calls** other than the ones the Agent SDK makes to
  Anthropic on your behalf. Usage figures are read from local log files.

## What is dangerous by design

- **"Permissions: Skip all"** (`bypassPermissions`) means exactly that — every
  tool call runs unprompted. Tiles launched this way are outlined in red. Use it
  when you would have used `--dangerously-skip-permissions` in the terminal, and
  not otherwise.
- **The finish chain can sleep or shut down your machine.** Destructive steps
  require a second confirming click, re-checked on the server, and arming is
  never restored across a restart.
- Sessions inherit your `~/.claude/settings.json`, so anything auto-approved in
  your terminal is auto-approved here.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem.

Report it through GitHub's private vulnerability reporting (the **Security** tab
→ *Report a vulnerability*), or by emailing the repository owner. A reply should
be expected within a week. Please include what an attacker gains, and a
reproduction if you have one.

## Dependency policy

Dependencies are deliberately few: `ws` on the server, React on the client, and
the Claude Agent SDK. Dependabot is enabled for npm and GitHub Actions, grouped
and monthly so routine bumps stay quiet; security advisories arrive immediately
and automated security fixes are on.

## When this repository becomes public

Two protections are free for public repositories but unavailable on a private
personal repository, so they are staged rather than forgotten:

- **Secret scanning and push protection** — enable both in *Settings →
  Code security*; push protection is what blocks a credential before it lands.
- **CodeQL** — the workflow already exists at
  [`.github/workflows/codeql.yml`](.github/workflows/codeql.yml) and is gated on
  repository visibility, so it starts running by itself with no edit needed.
