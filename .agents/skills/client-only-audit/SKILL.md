---
name: client-only-audit
description: Audit zpcrweb's code for violations of its client-only architecture — any user data (file bytes, parsed run/plate/curve data, filenames, USB traffic, error state) or telemetry leaving the browser to any server. Use when asked to check/verify/audit that the app doesn't phone home, before a release, or periodically as a standing security check.
---

## What this checks

zpcrweb's core promise is that a user's `.zpcr`/`.pcrd`/`.pltd` file and everything derived from
it (curves, Cq values, plate/sample/target names, USB traffic logs, error messages that might
quote file content) **never leaves the browser**. This skill audits the current code for
violations of that promise — not for policy compliance, but for the literal behavior of the
code as it exists right now.

**Do not trust anything that isn't code.** Comments, docstrings, README/ARCHITECTURE.md prose,
variable names like `sanitized` or `anonymized`, and prior audit results are all claims, not
evidence — the whole point of this audit is that a comment saying "this doesn't send user data"
can be wrong or stale. Every finding must be traced to the literal bytes placed on the wire by
reading the actual call site and everything that constructs its arguments. If a comment and the
code disagree, the code wins and the comment is itself worth flagging (misleading documentation
is its own finding).

## Method

### 1. Enumerate every network egress point

Grep the whole repo (`packages/core/src`, `apps/web/src`, `apps/web/index.html`, `apps/web/public`,
service worker files, and any build config that can inject remote scripts) for every API capable
of sending bytes off the device:

```
fetch(              XMLHttpRequest      navigator.sendBeacon    WebSocket(
new Image().src     EventSource(        <script src=            <link  rel=... href=
<img src=           <iframe src=        <form action=           postMessage( (to a cross-origin target)
Worker(  / SharedWorker(  (if it can reach network)   navigator.serviceWorker
```

Don't stop at `apps/web/src` — also check `packages/core/src` (isomorphic, so anything it sends
runs in the browser too), `tools/*.mjs` if they share code with the app, `index.html`'s literal
markup, and `package.json`/`vite.config.ts` for anything that pulls in a CDN-hosted script, font,
or analytics/error-reporting SDK (Sentry, PostHog, Google Analytics, a CDN-hosted font, etc.) —
those are egress points even with zero application code calling them explicitly.

USB (`packages/core/src/usb/`, WebUSB) talks to local hardware over a cable, not a network — it's
out of scope for this audit unless a USB code path also constructs a network request (e.g. to
"phone home" a run summary), which would itself be a finding.

### 2. For each egress point, trace what's actually being sent

Read the call site and walk backward through every variable that ends up in the URL, body,
query string, or headers, until you reach either a literal/constant or a dead end you can't
resolve. Ask: does any of it derive from —

- bytes read from a user-supplied file (`.zpcr`/`.pcrd`/`.pltd`/`.plt.csv`/Biomeme `.json`)
- anything decoded from those bytes (curves, Cq values, well/sample/target/protocol names,
  timestamps, calibration data, run reports, USB traffic logs)
- filenames or paths the user chose
- error messages or stack traces that might embed any of the above (a `catch` block that
  stringifies an exception carrying file content, or logs `e.message` built from parsed data)
- anything read from IndexedDB, localStorage, or the URL hash/fragment (which itself may carry
  a password or run name — see `apps/web/ARCHITECTURE.md`)

If the answer is no for every argument — the request only carries a hardcoded URL, a static
asset path, or a value the *user typed as the destination itself* (e.g. fetching a URL the user
pasted, to *load* a file) — it's not a violation. Loading a user-given URL into the app is
inbound and fine; the audit is about outbound user data, not about the existence of `fetch`
itself. `credentials: "omit"` and similar options don't matter to this check — they affect
what the *browser* attaches, not what the *code* explicitly puts in the request.

### 3. Check what the browser attaches automatically, not just what the code passes explicitly

A request can carry user data without the code ever mentioning it: cookies, `Referer`/
`Referrer-Policy`, or a URL path/query string built by string concatenation from data that looks
innocuous in isolation. Check each request's URL construction end to end, not just its `body`
argument.

### 4. Check for build-time or deploy-time egress too

A client-only architectural claim can be violated outside application source: a Vite plugin that
uploads source maps to a third party, a CI step that posts build artifacts somewhere, an
`index.html` `<meta>` referrer policy that's more permissive than it looks. Skim
`vite.config.ts`, `package.json` scripts, and `.github/workflows/*` for anything that transmits
repository or build content — out of scope for *this* audit's main goal (which is about user
*data*, not source code) but worth a one-line mention if something looks like it could leak a
user's file via a source-map upload or crash-reporting integration wired into the build.

## Reporting

For a clean result, say so plainly and name what was checked (egress points found, and why each
is either absent or user-data-free) — a report that just says "looks fine" without showing the
grep sweep and the trace isn't useful, since the whole point is that the audit is evidence-based
rather than a restatement of the architecture doc's claim.

For each violation, report:
- the file and line of the egress call
- the exact data reaching it, traced back to its source
- why it's a violation (which category above it falls into)

Do not fix violations unless asked — this skill is a check, not a repair; if the user wants the
finding fixed, treat that as a separate, explicit follow-up so the fix gets its own review.

## Why this exists, and why it's occasional rather than continuous

This is expensive to run well (it requires actually reading code, not just grepping) and the
app's egress surface changes rarely, so it's meant to be run periodically — before a release, or
when someone touches networking code, or on request — rather than on every change. See
`ARCHITECTURE.md`'s "Client-only: no user data leaves the browser" for the property this skill
exists to double-check, and update that section if this audit's scope or method changes
materially.
