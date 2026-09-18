# Local patches to vendored agy-bridge

Base: agy-bridge **0.4.1** (= npm `latest` as of 2026-07-25 — upstream has no fix).
Patched file: `dist/index.js` only (no `src/` is vendored). Pristine copy: `dist/index.js.orig-0.4.1`.

**Any `npm i agy-bridge` / re-vendor silently reverts all of this.** Version number will still
read 0.4.1, so a reinstall does not look like a downgrade. Re-apply, then re-run the verifier.

---

## 1. Model routing was dead — every tool ran on agy's default (2026-07-25)

**Symptom.** Every tool result footer read:

```
[agy-bridge] model: agy default | note: no preferred model available; using agy's own default model
```

No per-tool routing, no quota failover chain, `adversarial_review` was *not* getting Pro.
Failure was silent — delegation kept working, just always on one unintended model.

**Cause.** `agy` >= 1.1.x prints slugs from `agy models` (`gemini-3.6-flash-high`), but the
bundled `TOOLS[].chain` entries were display names (`"Gemini 3.5 Flash (High)"`). `resolveChain`
matched with exact `available.includes(m)` → filtered to empty → soft-fell back to agy's default.

**Fix.** Match on a normalized key (lowercase, strip non-alphanumerics) and return the CLI's own
canonical spelling. Applied to the chain filter, the explicit-`model` path, and `defaultModel`.
Both spellings now resolve, so a future format flip does not silently break routing again.

Added near `parseModels`:

```js
function normModel(name) { return String(name).toLowerCase().replace(/[^a-z0-9]/g, ""); }
function canonicalize(name, available) {
  const key = normModel(name);
  return available.find((a) => normModel(a) === key);
}
```

## 2. Chains retuned for Gemini 3.7 Flash (GA 2026-08-13, rev 2026-08-15)

3.7 Flash beats 3.6 Flash on coding/agentic (DeepSWE 65.3 vs 49.0, Terminal-Bench v2.1 85.8 vs 78.0,
OSWorld 47.9 vs 33.8) and on long-context retrieval — so flash tiers shift 3.6 → 3.7 and 3.5 drops
out of every chain. **3.1 Pro is still the newest Pro** and still leads abstract reasoning
(ARC-AGI-2 77.1) → Pro stays first only in `adversarial_review`.

| tool | chain |
|---|---|
| `analyze_files` | `gemini-3.7-flash-high` → `gemini-3.6-flash-high` → `gemini-3.1-pro-low` |
| `deep_search` | `gemini-3.7-flash-medium` → `gemini-3.7-flash-high` → `gemini-3.6-flash-medium` |
| `web_lookup` | `gemini-3.7-flash-medium` → `gemini-3.7-flash-high` → `gemini-3.6-flash-medium` |
| `adversarial_review` | `gemini-3.1-pro-high` → `claude-opus-4-6-thinking` → `gemini-3.7-flash-high` |
| `delegate` | `gemini-3.7-flash-high` → `gemini-3.6-flash-high` |
| `follow_up` | (empty by design — resumes the prior session's model) |

Cost: 3.7 Flash is on **launch promo — ~half of 3.6 Flash ($0.75/$3.75 per 1M in/out) until
2026-12-31**. Better *and* cheaper → no reason to keep 3.6 first anywhere. Re-check chains when the
promo ends (Jan 2027).

3.7 benchmark figures: single `web_lookup` pass 2026-08-15, aggregator-sourced → re-verify if doubted.

## 2b. Model routing died again — `agy models` grew a second column (2026-08-15)

**Symptom.** Same silent footer as §1: `model: agy default | note: no preferred model available`.

**Cause.** New `agy` prints `gemini-3.7-flash-high\tGemini 3.7 Flash (High)` plus a
`Fetching available models...` header line. `parseModels` kept the **whole line**, so the
normalized key included the display name too and `canonicalize` matched nothing. §1's normalization
did not save it — the available-side strings were the corrupted ones.

**Fix.** `parseModels` now takes the first whitespace/tab-separated column and drops non-id lines
(`...` header). Slug-only output still parses identically, so both CLI formats work.

## 3. `model` param description fixed

Read `e.g. "Gemini 3.1 Pro (High)"`. That value hit the **throw** branch (`Model "..." is not
available`), not the soft fallback — a hard error for anyone following the hint. Now shows slugs.

---

## 4. Prompt moved from argv to stdin, results read from the stream-json envelope (2026-08-21)

**Symptom.** None yet — this is a latent-failure fix. `buildArgs` ended with `"-p", req.prompt`, so
every delegation put the entire prompt on the Windows command line. Large prompts risk truncation at
the command-line limit; prompts containing quotes, backticks, `&`, `|`, `^`, `%`, `$(...)` or
backslashes risk mangling. `arcobaleno64/gemini-plugin-cc` moved to stdin for exactly this reason and
documents a 24K argv ceiling for older agy.

**Fix.** `agy` 1.1.17 accepts the prompt on stdin. Verified shape:

```
agy --input-format stream-json --output-format stream-json --print-timeout <n>s -p ""
```

with **one NDJSON line** on stdin:

```json
{"event":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]}}
```

The envelope name matters: `{"event":"user", ...}` — a missing `event` field errors with
`stream input message is missing the "event" field`, and a missing `message` field errors with
`stream input "user" message is missing the "message" field`.

Changed in `dist/index.js`:
- `buildArgs` emits the four stream-json flags and `-p ""`; the prompt is gone from argv.
- `spawnDetached(file, args, cwd, stdinData)` gained a 4th parameter; writes the NDJSON line then
  closes stdin. An `error` handler on stdin swallows EPIPE if agy exits first.
- New `buildStdin(prompt)` and `parseStreamResult(stdout)`.
- `runAgy` resolves `{out, meta}` instead of a bare string.

**Bonus — the result envelope replaces two fragile mechanisms.**
`{"event":"result","result":{...}}` carries `conversation_id`, `status`, `error`,
`duration_seconds` and `usage` (input/output/thinking/cache tokens). So:
- `sessionId` now comes from `conversation_id` directly; the `last_conversations.json` read is a
  **fallback only**. That file is keyed by cwd and raced with concurrent runs.
- `status === "ERROR"` is checked *before* the exit code, because **agy exits 0 even on error**.
  `detectQuota` is run against the envelope's `error` text first, then the log — so quota failover
  still fires when the log poller has not seen it yet.
- The tool footer now reports `tokens: <in> in / <out> out` and `took: <n>s` via `describeRun`.

**Deliberate fallback.** `parseStreamResult` returns `{parsed:false, response:<raw stdout>}` when no
result event parses, so a future agy output-format change degrades to the pre-patch behaviour rather
than breaking delegation outright. Verified by `scripts/verify-chains.mjs`.

**Proven.** A 71,120-char prompt containing `"quoted"`, `'single'`, backticks, `& | > < ^ % !`,
`$(echo hi)` and backslashes round-tripped intact, returning the expected marker.

## 5. Background jobs — `delegate_async` / `job_status` / `job_result` / `job_cancel` (2026-08-21)

**Symptom.** `spawnDetached` is a misnomer: the MCP handler awaits the child, so a 10-minute
`delegate` blocked the entire Claude turn. No fire-and-forget, no polling, no cancel. This was the
one real capability `gemini-plugin-cc` had and this bridge did not.

**Store.** `~/.claude-bridges/agy-jobs/<sha1(resolve(cwd)).slice(0,12)>/<jobId>.json`, one JSON per
job: `{id, tool, prompt, cwd, model, timeoutSec, status, createdAt, startedAt, finishedAt, pid,
output, truncated, error, sessionId, usage, durationSeconds, attempts, note}` with
`status ∈ queued|running|done|error|cancelled`. Capped at **50 records per workspace**; on each new
job the oldest *finished* records are evicted (a running job is never evicted).

**Worker — same file, different argv.** No second entry point to keep in sync: the `src/index.ts`
tail branches on `process.argv[2] === "--job-worker"` and runs `runJobWorker(process.argv[3])`
instead of starting the MCP server. Self-path via `fileURLToPath(import.meta.url)`.

**Reuse, not reimplementation.** The model-failover loop was extracted out of `createToolHandler`
into `runWithFailover(req, cfg, registry, cooldowns, deps)`; the sync tools and the async worker now
share one code path, so chain routing, quota cooldowns and `QuotaError` behave identically in both.

### Two Windows traps, both found by testing

**a. `detached: false` kills the worker with its parent.** The pre-existing `spawnDetached` uses
`detached: process.platform !== "win32"` — harmless there because the parent awaits the child.
Reused as-is for the job worker it meant every job died the instant the MCP server process exited
(observed: `worker process died before producing a result` within 1s). On Windows `detached: true`
is required for a child to survive its parent; `startJob` sets it unconditionally.

**b. `spawn("taskkill", ...)` silently does nothing.** `killJob` must kill the *tree* — the worker
spawns `agy.exe` as its own child, and on Windows killing a parent orphans its children. The first
attempt used a bare `"taskkill"` command name and failed silently (stdio ignored, and the async
`error` event is not caught by a surrounding `try`): after "cancelled" was reported, `agy.exe` was
still running with the worker as its live parent. Fixed with the absolute path
`%SystemRoot%\System32\taskkill.exe`, args `/PID <pid> /T /F`, plus an `error` listener falling back
to `process.kill`. Re-verified: `agy.exe` count 1 → 0 across a cancel.

**Dead-worker reaping.** `job_status` calls `reapJob`, which flips any `running` job whose `pid` is
gone to `error: worker process died before producing a result.` — a killed worker shows as an error,
never as a permanently stuck `running`. `pidAlive` treats `EPERM` as alive.

**Race avoided by design.** The parent writes `pid`/`status=running`/`startedAt` right after spawn;
the worker writes **nothing** at startup and, when finished, re-reads the record and merges its patch
on top. A job cancelled mid-run is detected at that merge (`status === "cancelled"` → worker exits
without overwriting).

### Deliberately NOT ported from gemini-plugin-cc

| feature | why not |
|---|---|
| dual-engine (Gemini CLI + agy) | Gemini CLI is not installed; consumer access was retired 2026-06-18. |
| model aliases (`flash`/`pro`/`lite`) | The explicit slug chains here are finer-grained — an alias layer would be a downgrade. |
| review-gate Stop hook | The escalation ladder in `~/.claude/REFERENCE.md` already covers this. |
| `/transfer` context export | The `handoff` skill plus the memory-API `/docs` namespace already cover this. |

---

---

## Verifying

Editing `dist/index.js` does nothing until the **agy-bridge MCP server restarts** — it is a
long-lived stdio process. A tool call made in the same session still shows the old behaviour, so
do not treat that as the patch failing.

Static check (evaluates the bundle's own `parseModels`/`canonicalize` against live `agy models`,
i.e. the exact predicate `resolveChain` uses — no re-implementation):

```bash
node ~/claude-bridges/agy-bridge-vendored/scripts/verify-chains.mjs
```

It covers patches 1-5: live chain resolution, the legacy display-name regression guard, the
argv/stdin split, `parseStreamResult` (including its raw-stdout fallback), quota detection from the
envelope's error text, and the presence and wiring of the four job tools plus the two Windows fixes
in patch 5. Exit code 0 = all pass; expected output ends in `ALL CHECKS PASS`. After a restart, confirm live by checking a footer names a real model:

```
[agy-bridge] model: gemini-3.7-flash-medium | tokens: 16319 in / 34 out | took: 3.2s | session: ...
```

For the background job path, the end-to-end check is: `delegate_async` returns a `job_id` within a
second, `job_status` shows `running`, and `job_result` later returns the output with a
`[agy-bridge job <id>]` footer.

Optional floor: set `AGY_DEFAULT_MODEL=gemini-3.7-flash-high` in the `env` block of the
`agy-bridge` entry in `~/.claude.json`. `resolveChain` appends it as the chain tail. It does
**not** apply to `follow_up`, which short-circuits on `conversationId`.

## 8. Console window flash on every agy invocation (2026-08-27)

**Symptom.** A window pops and vanishes too fast to read whenever an agy tool is called.
Invisible in itself, but it takes foreground focus — enough to pull the user out of a
fullscreen game.

**Cause.** `agy.exe` is a **CONSOLE-subsystem** PE (verified: subsystem=3, x64, 178 MB).
Windows gives a console-subsystem child its own console window unless the parent passes
`CREATE_NO_WINDOW`. Node maps that to `windowsHide`, which **defaults to `false`** on
`execFile`.

Every spawn site had `windowsHide: true` except one — and that one runs on every agy
invocation:

```js
// ModelRegistry loader, both at createServer() and in the job worker
await execWithClosedStdin(cfg.agyPath, ["models"], { cwd, timeout: 3e4, maxBuffer: 1<<20 });
//                                                  ^ no windowsHide
```

**Fix.** Force it inside the wrapper rather than at the two call sites, so nothing added
later can miss it:

```js
var execWithClosedStdin = (file, args, options) => {
  const promise = execFileAsync(file, args, { ...options, windowsHide: true });
```

`windowsHide` goes **after** the spread so a caller cannot override it back to false.

**Not the cause, checked and left alone:** `spawnDetached` (line ~197) and the taskkill
spawn already set `windowsHide: true`; the job worker's `detached: true` gives the worker
`DETACHED_PROCESS`, which creates no console for a console app on its own.

**Verified.** `node --check` clean; `execFile(agy, ["models"], {windowsHide:true})` with
stdin closed returns all 14 model lines in ~19 s.

**Takes effect only after the MCP server process restarts** — the running server holds the
old code in memory. Reconnect via `/mcp` or relaunch Claude Code.

**Side observation, not fixed:** `agy models` costs ~19 s. `ModelRegistry` caches per
instance, so sync tools pay it once per server start, but the async job worker builds its
own registry per job and pays it again every time.

## 3. Transient agy failures were never retried (2026-08-30)

**Symptom.** Delegations intermittently produced nothing. Reported by the user as
"agy-bridge tends to not respond to longer context".

**Measured, not assumed.** A 90-run benchmark driving `agy` directly (8-way parallel) hit
4 hard failures, 3 of them identical:

```
Error: Eligibility check failed: failed to get profile picture:
  Get "https://lh3.googleusercontent.com/...": net/http: TLS handshake timeout
Error: Eligibility check failed: Get "https://www.googleapis.com/oauth2/v2/userinfo": EOF
```

A stepped stdin probe (16 KB -> 2 MB single-line stream-json) proved the failure is **not**
size-related: 2 MB succeeded on 3 of 4 attempts and 1.4 MB failed on one. There is no
64 KB `bufio.Scanner` cliff and no Windows argv limit involved — the bridge already sends
the prompt over stdin, not argv. The correlation with "long context" is indirect: long
tasks run longer and are usually fanned out in parallel, and parallel `agy` startups race
on the same Google auth endpoints.

**Cause.** `runWithFailover` continued the chain **only** for `QuotaError`; every other
error was rethrown on the first attempt. A transient network failure in agy's startup
eligibility check therefore killed the whole delegation with zero retries.

**Fix (`dist/index.js`, marker `PATCH-TRANSIENT-RETRY-20260830`).**
- `TransientError` + `isTransient()` classify retryable failures (eligibility check, TLS
  handshake, `net/http`, EOF, context canceled/deadline, connection reset/refused, 5xx,
  oauth2, and empty output).
- Retry the **same** model with exponential backoff (1.5s, 3s), `AGY_RETRIES` (default 2).
- Only after retries are exhausted does it fall through to the next model in the chain.
- Hard errors (bad model name, missing `content`/`files`) still fail immediately.
- `exit`->`close` stdout drain window raised 2s -> 15s so a large stdout cannot be
  truncated into a spurious "empty output".

## 4. `WaitMsBeforeAsync: got string, want integer` — the 2026-08-23 open bug, correctly diagnosed (2026-08-30)

**The previous diagnosis was wrong.** `PATCHES.md` §5 / the memory note blamed the
background-promotion path for marshalling `WaitMsBeforeAsync` as a string. The bridge
never sends that field.

**What it actually is.** `WaitMsBeforeAsync` is a field of **agy's own `run_command`
tool schema** — the tool the *model* calls. Extracted from `agy.exe`:

```
WaitMsBeforeAsync protobuf:"varint,4,opt,name=wait_ms_before_async,json=waitMsBeforeAsync"
  google3/.../cortex_go_proto.(*CortexStepRunCommand).GetWaitMsBeforeAsync
```

It is a protobuf `varint`. When Gemini emits `{"CommandLine":"...","WaitMsBeforeAsync":"0"}`
with a *quoted* zero, agy's argument validator rejects the tool call and the whole run
dies with `invalid arguments:\n- at '/WaitMsBeforeAsync': got string, want integer`.
That is a nondeterministic model-output defect. It correlates with long runs only because
long runs make more tool calls, so they are likelier to hit one — and are likelier to
cross the 120 s MCP threshold at the same time. Duration was a confounder, not the cause.

**Fix (marker `PATCH-TOOLARG-RETRY-20260830`).** Classify it as retryable: a resample
almost always emits a well-formed call. Deliberately narrow — the text must contain BOTH
`invalid arguments` AND a JSON-pointer `at '/<field>'`, so a genuine bad argument from the
bridge stays a hard failure.

**Verification.** `scripts/patch-transient-retry.py` applies §3; §4 was applied on top.
The suite in `Q:/Temp/.../scratchpad/ctx/verify_patch.mjs` loads the real patched
`dist/index.js` (bootstrap stripped, internals re-exported), injects a fake `spawnChild`
through the existing `deps` seam, and asserts 22 checks: retry-then-recover, same-model
retry, backoff, hard errors not retried, empty output retried, chain advance after
exhausting retries, and both classifier tables. 22/22 pass.

## 4. `web_lookup` self-aborted at 120s on most real queries (2026-09-05)

**Symptom.** `web_lookup` failed "quite frequently, almost always". Two shapes, same cause:

```
MCP tool "agy-bridge/web_lookup" is still running after 120s. It was moved to the background ...
<task-notification> status=failed
Task failed: agy failed: timeout waiting for response
```

Transcript sweep, all `web_lookup` calls: every call that ran past ~120s failed this way, at
~8s after the background promotion. Calls that finished under 120s always succeeded.

**Cause.** `buildArgs` passes the tool's `timeoutSec` to agy as `--print-timeout`. `web_lookup`
was the only tool at **120s** — every other tool is 180-600, and agy's own default is 5m. A
grounded lookup that fetches several pages routinely runs past two minutes, so *agy* hit its own
print timeout and exited non-zero. That stderr, `timeout waiting for response`, matches neither
`QUOTA_RE` nor `TRANSIENT_RE`, so it was a **hard** failure: no same-model retry, no chain
failover, immediate abort. Under `AGY_ON_FAILURE=strict` that surfaces as a flat refusal.

The 120s background promotion is a separate, benign mechanism (Claude Code's MCP tool *idle*
timeout — agy-bridge sends no progress notifications, so every slow call trips it). It only
looked like the fault because the real timeout fired 8s later.

**Fix.**
- `web_lookup` `timeoutSec` **120 → 300**, matching agy's own `--print-timeout` default.
- `describeFailure()` rewrites `timeout waiting for response` into a message naming the knob
  (`timeoutSec` / `AGY_TIMEOUT`) instead of echoing agy's stderr, which read like a network fault.
  Applied to both the stream-`ERROR` and the non-zero-exit reject paths.
- Deliberately **not** added to `TRANSIENT_RE`: retrying a timeout costs the full budget again,
  and `retries=2` x 3 models would mean a 45-minute worst case. A timeout at 300s is a real
  failure, and should be reported as one.

Outside this repo, in `~/.claude/settings.json` env, so a legitimately slow lookup returns inline
instead of arriving out-of-turn as a task notification:

```
CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = 310000
```

**Get the knob right — there are two, and only one of them is this one** (checked against the
2.1.261 binary after a first attempt set the wrong one and changed nothing):

| env var | what it actually is | governs the 120s promotion? |
|---|---|---|
| `CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS` | "still running after Ns, moved to the background". Default hardcoded **120000**, clamped to [0, 2^31-1], 0 disables. | **yes** |
| `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` | hard *abort* after N ms of no response **and** no progress notification. Effective value is `min(max(idle, per-server timeout, 1000), cap)`. | no |

Because idle takes the **max** with the per-server `timeout`, the `timeout: 600000` already set on
agy-bridge in `~/.claude.json` had raised its idle ceiling to 600s all along. Idle was never the
constraint; it is left at 300000 only so servers without a per-server timeout (context7) get more
than the stdio default.

Changes need an MCP server restart / new Claude Code session to take effect.

**Verified 2026-09-05 after restart.** A deliberately heavy grounded lookup (9 models x pricing +
context + benchmarks, official sources only) completed in **168.2s** on `gemini-3.8-flash-medium`.
That is the exact shape of call that died at 128s before this patch.

## 6. `AGY_DEFAULT_MODEL` was appended, not prepended — and was never even set (2026-09-12)

**Symptom.** A peer session's `delegate_async` calls, believed to explicitly pass
`model: "gemini-3.8-flash-high"`, all came back `model: gemini-3.7-flash-high` with an empty
`attempts` array (no cooldown/quota event at all — checked the raw job JSON).

**Cause, two independent things.**
1. The peer's `model` value never reached the tool as a JSON key — it was concatenated onto the
   end of the `prompt` string as literal text (`\n<parameter name="model">gemini-3.8-flash-high`),
   a caller-side tool-call construction defect, not this bridge. `args.model` was `undefined`, so
   every call took the no-explicit-model branch.
2. That branch was wrong anyway. `resolveChain` built `models` from the tool's hardcoded chain
   (`ASYNC_CHAIN = ["gemini-3.7-flash-high", "gemini-3.6-flash-high"]`, stale since 3.8 shipped)
   and only *appended* `AGY_DEFAULT_MODEL` if present and not already in the list. `AGY_DEFAULT_MODEL`
   was never actually set in `~/.claude.json`'s `agy-bridge.env` — the "optional floor" this file's
   §"Verifying" section describes was never applied. So every no-explicit-model call has run
   `gemini-3.7-flash-high` — the stale chain's first entry — since 3.8 shipped.

**Fix.**
- `~/.claude.json` → `agy-bridge.env`: added `"AGY_DEFAULT_MODEL": "gemini-3.8-flash-high"`.
- `dist/index.js` `resolveChain` (marker `PATCH-DEFAULT-FIRST-20260912`): default is now
  **prepended**:
  ```js
  const models = defaultCanonical
    ? [defaultCanonical, ...chainModels.filter((m) => m !== defaultCanonical)]
    : chainModels;
  ```
  A future model-tier bump changes one env var; a stale hardcoded chain can no longer outrank it.

**Verified.** `node scripts/verify-chains.mjs` → `ALL CHAINS RESOLVE` / `ALL CHECKS PASS`, same as
before the edit. Takes effect only after the MCP server restarts (see "Verifying" above).

**Open, not fixed here:** the leaked `<parameter name="model">...</parameter>` text is on the
calling session's side — its MCP client is serializing the `model` argument into the prompt
string instead of as a sibling key. Flagged back to that session; not reproducible or fixable
from inside this bridge.
