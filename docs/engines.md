# Engines

What the `consult` tool actually calls, and what each engine needs to work.

The `consult` tool currently fans out to **five engines**:

| Engine | Wraps | Tier |
|---|---|---|
| `copilot` | GitHub Copilot CLI (`copilot -p`) | Free (GitHub) |
| `codex` | OpenAI Codex CLI (`codex exec`) | Free (ChatGPT) |
| `agy` | Antigravity / Gemini CLI | Google AI Plus (low quota); **in the default order while it drains its remaining quota (2026-10-27); removed once exhausted** |
| `deepseek` | `deeperseeker` proxy over a DeepSeek web account (HTTP, not a CLI) | Free (throwaway account) |
| `nim` | NVIDIA NIM hosted API (HTTP, not a CLI) | Free trial tier; in the default order, with a 5-model fallback chain |
| `openrouter` | OpenRouter free models (HTTP, not a CLI) | Free (rate-limited); in the default order (after `nim`), with a 5-model fallback chain |
| `opencode` | Official OpenCode CLI (`opencode`, logged in to OpenCode Zen) on its free models | Free; in the default order (after `openrouter`), with a 5-model fallback chain (`OPENCODE_CHAIN` overrides, `--opencode-model M` starts it at M). Runs in an empty temp dir with the read-only `plan` agent, prompt on stdin. **Free models may be logged or used by the provider: send non-private prompts only.** |
| `dsapi` | Official DeepSeek API, flash models only (HTTP, not a CLI) | Pay-per-token (cheap); **opt-in (not in default order)**, but also the automatic fallback of `deepseek` |
| `gemini` | Google Gemini API (OpenAI-compatible endpoint, HTTP, not a CLI) | AI Studio free-tier key (`GEMINI_API_KEY` or `~/.gemini-api-key`); prompt-only; in the default order (last), and also the automatic fallback of `agy` |
| `azure` | Azure OpenAI chat completions (HTTP, not a CLI) | Azure subscription key (`AZURE_OPENAI_KEY` or `~/.azure-openai-key`) plus endpoint (`AZURE_OPENAI_ENDPOINT` or `~/.azure-openai-endpoint`); in the default order (after `opencode`); one model, no chain; prompt-only |

`agy` was opt-in because its Google AI Plus quota is small; since 2026-10-27 it is in the default order until that quota is used up (before: opt in with `--order copilot,codex,deepseek,agy`)
or the MCP `order` argument, ideally once per review.

`deepseek` is in the default `CONSULT_ORDER` (last, so in mode `first` it is only a fallback). It needs the
`deeperseeker` proxy on `127.0.0.1:4000`; if the proxy is down or has no key, it falls back to the official API (`dsapi`, flash only, label `deepseek->dsapi`; see below), or fails soft
if that has no key either, and the other engines still answer. `nim` is in the default order too (after `deepseek`, so the default panel is `copilot,codex,deepseek,agy,nim,openrouter,opencode,azure,gemini`); it walks a fallback chain, see below.
`openrouter` is in the default order too (last; since 2026-10-27, so the default panel is `copilot,codex,deepseek,agy,nim,openrouter,opencode,azure,gemini`). Its default model (`baidu/ernie-5.5-flash-preview:free`) is a different family from `nim`'s, so the two count as separate voices. Drop it with an explicit `--order` (e.g. `--order copilot,codex,deepseek`).
`dsapi` is opt-in as well (`--order copilot,codex,deepseek,dsapi`), and `deepseek` falls back to it on its own (see below).
Unlike the CLI engines, `deepseek`, `nim`, `openrouter` and `dsapi` get no cwd, shell or file access — they only ever see the prompt text, so give them self-contained prompts.

## `openrouter` (OpenRouter free models)

Set up the key once: put it in `~/.openrouter-key` (restrict it: `chmod 600` on macOS/Linux; on Windows
`icacls <file> /inheritance:r /grant:r "%USERNAME%:(R,W)"`) or export `OPENROUTER_API_KEY`. The environment variable wins.
No key means the engine is reported as `[failed] no key`; the other engines still answer.

Requests go to `https://openrouter.ai/api/v1/chat/completions` (`max_tokens` 1500).
Free models are rate-limited, so a bare `openrouter` (and a model set by `--openrouter-model` / `OPENROUTER_MODEL`, or
`openrouter:<that default>`) walks a fallback chain, starting with the requested model (5 attempts at most; override the list with
`OPENROUTER_CHAIN=a/x:free,b/y:free`): `baidu/ernie-5.5-flash-preview:free` -> `dots-studio/dots-3-note-preview:free` -> `cohere/north-mini-code:free` ->
`recursive/flint-v1.0:free` -> `liquid/lfm-3-1.7b:free`. It steps past 404, 410, 429, 5xx (also a 200 carrying such an error),
a 400 "not a valid model ID" (delisted model), timeouts, network errors, empty answers and reasoning-only answers; any other error
(401 bad key, 402 no credit, other 400) ends the chain at once. A leading `<think>...</think>` block is stripped. The result is labelled
with the model that answered (`openrouter:<model>`); if every attempt fails, the failure lists each model and why (a 429 shows as
`rate-limited`). An **explicit** `openrouter:<other model>` in the order runs only that model, with the whole timeout and no chain.
Time budget: 60 s per attempt (`OPENROUTER_ATTEMPT_TIMEOUT_SEC`), whole chain within `OPENROUTER_TIMEOUT` (default 300 s = 5 x 60, maximum 600);
a later step with less than 15 s left is skipped. The free models answered a small code-review prompt in 2-21 s on 2026-10-27.
No model family appears in both this chain and the `nim` chain (a test enforces it), so the two engines are never the same voice. Left
out: `thinkingmachines/inkling[-small]:free` (403, agentic harnesses only), `google/gemma-4-*:free` and `xingchen-agi/xing4.0-29b-a4b:free`
(429 upstream on every call of the probe), the `nvidia/nemotron-*:free` models (same family as the `nim` chain).
Model precedence: `openrouter:<model>` in the order, then `--openrouter-model`, then `OPENROUTER_MODEL`, then the default.
Like `nim` and `deepseek`, it has no file access: the prompt must be self-contained.

`poolside/laguna-s-2.1:free` (the old default) and `liquid/lfm-2.5-2.6b:free` are no longer in the chain.
`lib/engines.js` uses `baidu/ernie-5.5-flash-preview:free` and `liquid/lfm-3-1.7b:free`, and its comment says the old default is gone (404, no provider).

## `dsapi` (official DeepSeek API, flash only)

Set up the key once: put it in `~/.deepseek-api-key` (restrict it: `chmod 600` on macOS/Linux; on Windows
`icacls <file> /inheritance:r /grant:r "%USERNAME%:(R,W)"`) or export `DEEPSEEK_API_KEY`. The environment variable wins;
the file may hold anything around the key, the first `sk-...` token is used. No key means `[failed] no key`; the other engines still answer.

**OpenRouter credit first (2026-10-28).** When an OpenRouter key exists (`OPENROUTER_API_KEY` or `~/.openrouter-key`), `dsapi`
first calls `deepseek/deepseek-v4.1-flash` on OpenRouter (model pinned in code, request carries `provider.data_collection: "deny"`)
and only then the official API. A 401/402/403 from OpenRouter (bad key, credit spent) is sticky for the rest of the process;
a 429/5xx/network failure falls back for that one request. `DS_UPSTREAM=deepseek` forces the official API. Same rule as the
key proxy of the DS worker (`~/.claude/bin/ds-keyproxy.py`). A result served by OpenRouter carries `upstream: "openrouter"`.
The shared `:free` pool (1000 requests/day per account, panel and agent flows together) has a reserve: with `OR_FREE_RESERVE=<n>`
the `openrouter` engine skips `:free` models once `GET /api/v1/key` reports `<= n` requests left (checked at most once a minute;
the panel's own default is 0, i.e. no lookup, 429 steps the chain on; agent flows use 50, hosted test runs 200).

Requests go to `https://api.deepseek.com/chat/completions` (OpenAI-compatible; `max_tokens` 1500, 90 s timeout, thinking mode off).
One retry on HTTP 429 (honouring `Retry-After`, capped), 5xx, a timeout or a network error; none on 400/401/402/403.
A leading `<think>...</think>` block is stripped. The default model is `deepseek-flash`, the id DeepSeek keeps pointed at its
current Flash model (checked against `GET /models`; the legacy `deepseek-v4-flash` still works).

**Flash only.** The engine is for cheap second opinions, so it refuses anything that is not a Flash model. Because DeepSeek
renames model ids over time, the rule is a pattern, not a fixed list: an id is accepted when it contains a `flash` token
(`deepseek-flash`, `deepseek-v6-flash`, `v4.1flash`, any casing) and does **not** contain `pro` or `reasoner`
(so `deepseek-v4-pro`, `deepseek-reasoner`, `deepseek-chat` and `deepseek-flash-pro` are refused). A refused model
(via `dsapi:<model>`, `--dsapi-model` or `DSAPI_MODEL`) fails with `dsapi is limited to flash` and no request is sent.
Model precedence: `dsapi:<model>` in the order, then `--dsapi-model`, then `DSAPI_MODEL`, then the default.

**Automatic fallback for `deepseek`.** When the `deeperseeker` proxy is unreachable (e.g. connection refused), has no key
or answers HTTP 5xx, the `deepseek` engine retries the prompt on `dsapi` and the result is labelled `deepseek->dsapi`,
so the default panel (`copilot,codex,deepseek`) keeps a DeepSeek voice while the proxy is down. A proxy that answers is
used unchanged; a proxy 4xx or a per-call model (`deepseek:<model>`) does not trigger the fallback. If the fallback fails
too, the failure lists both reasons. Listing both `deepseek` and `dsapi` in one order means two calls while the proxy is down.

**Usage guard.** Every request and the token usage of the response (prompt + completion) are counted per local day in
`~/.dsapi-usage.json` (`{"day","requests","promptTokens","completionTokens"}`). Past **300 requests/day** a one-line warning
(`[consult] dsapi: N requests today ...`) is printed in the footer (stderr in the CLI, appended to the result in the MCP
tool) for runs that can call dsapi. 300 is a soft alarm only: nothing is blocked, Flash is cheap.

## `nim` (NVIDIA NIM)

Set up the key once: put it in `~/.nvidia-nim-key` (restrict it: `chmod 600` on macOS/Linux; on
Windows rely on your user-profile ACL) or export `NIM_API_KEY`. The environment variable wins.

Order entries may be `engine` or `engine:model` (split on the first `:`, so model ids with `/` work).
A model is accepted on `copilot`, `codex`, `nim`, `deepseek`, `openrouter` and `dsapi`; `agy:x` and unknown engines are dropped.
(`copilot:<model>` is accepted syntactically, but auto-only Copilot plans reject `--model`; the engine then retries once on auto
and labels the result `copilot (auto; <model> unavailable on this plan)`.) `nim:<default model>` is the same entry as bare `nim`
and is deduplicated.
This lets one panel query several NIM models, each labelled `nim:<model>`:

```bash
node consult-cli.js --order nim:moonshotai/kimi-k3,nim:z-ai/glm-5.3,codex "prompt"
```

Model precedence for `nim`: `engine:model` in the order, then `--nim-model`, then `NIM_MODEL`, then the built-in default.

**Fallback chain.** Free-tier NIM models stall, vanish (HTTP 404, or 410 after end of life) or return reasoning only, so a bare `nim`
(and a model set by `--nim-model` / `NIM_MODEL`, or `nim:<that default>`) walks a chain, starting with the requested model:
`nvidia/nemotron-3-ultra-550b-a55b` -> `minimaxai/minimax-m3.1-flash` -> `nvidia/nemotron-3.5-super-vl-120b-a12b` -> `z-ai/glm-5.3-flash` -> `openai/gpt-oss-20b` (5 attempts at most;
override the list with `NIM_CHAIN=a/x,b/y,c/z`). It steps past 404, 410, 5xx, 429 (after the usual single retry), timeouts, network errors,
gateway errors, empty answers and reasoning-only answers; it stops on 400/401/402/403 and other 4xx (another model would fail the same way).
The result is labelled with the model that answered (`nim:<model>`); if every attempt fails the reason lists each attempt, and if the only
output was reasoning, the first reasoning-only reply is shown as a last resort. An **explicit** `nim:<other model>` in the order runs only
that model, with the whole timeout and no chain, so single-model evaluations stay honest. Time budget: each attempt gets at most 120 s
(`NIM_ATTEMPT_TIMEOUT_SEC`), and the whole chain stays within `NIM_TIMEOUT` (default and maximum 600 s, so 5 x 120 s); a later step with less than
15 s left is skipped (the first step always runs). The chain was picked from an eval on 2026-10-27 (code-review prompt with planted bugs): ultra answered in 27-79 s,
minimax-m3.1-flash in 93 s, super-vl in 57 s, all finding the bugs; glm-5.3 (396 s), glm-5.3-flash (319 s in that run, 10-15 s in later ones; it is the 4th step) and step-5-preview (228 s, 35-87 s later) were too
slow or too erratic for the first steps (`openai/gpt-oss-20b` answered in 5-10 s and closes the chain), deepseek-v4.1-flash answered 504, kimi-k3 410 (end of life), kimi-k2.6 404, and nemotron-3.5-bolt-e4b answered weakly. Latency varies a lot run
to run (the free queue is shared), which is why the chain mixes vendors.
If a model returns only reasoning and no final answer, the section starts with `[reasoning only: ...]`;
a `[truncated: hit max_tokens]` line marks cut-off answers (raise `NIM_MAX_TOKENS`); a truncated answer still counts as an answer.
Only a reasoning-only reply is shown in `--mode all` but fails over in `--mode first`, where the chain moves on to the next engine
(if every engine returns reasoning only, the first such reply is shown as a last resort with a note). Only a `<think>` block at the
very start of a reply is treated as reasoning; tags quoted later in an answer are left alone.

Free trial keys allow roughly 40 requests per minute; NVIDIA does not publish the limits and they may change.
Use is subject to the NVIDIA API Trial Terms (evaluation, non-production use). The budget is per key, so any
other application using the same key shares it. On HTTP 429 consult waits (`Retry-After`, else 5 s, max 15 s),
retries once, then reports the engine as rate limited.

Free-tier latency varies a lot by model: in a smoke test the default `nvidia/nemotron-3-ultra-550b-a55b` answered a
small review prompt in about 20 s, while some other models took 150 s or timed out at 180 s. NIM's `/v1/models` also lists
models this key cannot call (HTTP 404 `Function ... Not found for account`), so try a model before relying on it.
`nim` has its own timeout, independent of `CONSULT_TIMEOUT`: `NIM_TIMEOUT` seconds (default 600), always capped at 600
(10 minutes; a larger value is clamped, an invalid one falls back to 600). Engines run in parallel, so a slow model only
delays its own section. A 429 retry shares the same deadline.

`nim` requests are streamed (SSE): consult accumulates the deltas (answer and reasoning) and builds the same result as a
normal reply. Two limits sit at about 300 s: NVIDIA's gateway answers a real HTTP 504 (reported as
`NVIDIA gateway timeout ...`, no retry) when a model has not started answering by then, and Node's `fetch` gives up after
300 s without response headers or, mid-stream, without a data chunk (idle time between chunks, not total; reported as
`no response headers within ~300 s` / `stream stalled, no data for ~300 s` instead of `fetch failed`). In short: time to
first token must be at most about 300 s, and the whole stream may then run up to `NIM_TIMEOUT` (at most 600 s). Without
streaming the entire answer would have to be finished within 300 s, so `NIM_TIMEOUT` above 300 only helps models that
have started answering; a model stuck in the free-tier queue still fails at about 300 s. If the deadline hits mid-stream, the text received so far is returned with a
`[truncated: timed out after Ns]` note (reasoning-only partials are shown as reasoning-only; nothing received is a plain
timeout). A reply that is not `text/event-stream` is parsed as an ordinary completion. `deepseek` is not streamed. HTTP 504 means the
gateway gave up waiting for the first token; HTTP 502 is reported as a plain `NVIDIA gateway error (HTTP 502)` with the
response detail. Neither is retried.

When consult runs as the MCP `consult-bridge`, its registration needs `"timeout": 660000` or more for `nim` to use the full
10 minutes (the registration example in `docs/setup.md` uses that value). In `--mode first` the engines run one after another, so a
stalled `nim` (all three chain steps) holds up the chain for up to 600 s and `nim` plus a fallback can exceed 660 s: keep `nim` last in the order
(it is last in the default), or use `--mode all` (parallel, the default).

### Bi-weekly new-model check

NIM adds models often, so a consult run that uses `nim` (bare `nim` or `nim:<model>` in the order) checks
`/v1/models` at most once every 14 days (`NIM_MODELS_CHECK_DAYS`), in a detached background process, whenever a
NIM key exists. The cost is one `/v1/models` request every 14 days; no model is ever called. The first check only
records a baseline. Later checks diff the listing against the ids seen before (embedding, guard, speech and
similar non-chat ids are ignored). The result is one notice line until the next check (on stderr in
`consult-cli`, appended to the tool result in `consult-bridge`), e.g.
`[consult] NIM: 2 new models since 2026-10-10: a/b, c/d -> worth a look in a separate session; try --order nim:<id>`
(at most 6 ids, then `(+K more)`). A listing is not proof that a model is callable for your key or fast enough
on the free tier, so treat it as a hint.

- Result cache: `~/.cache/claude-bridges/nim-models.json` (or `$CLAUDE_BRIDGES_CACHE_DIR/nim-models.json`), shape
  `{checkedAt, attemptAt, baselineAt, seen, new: [ids], error}`; it never contains the key. `checkedAt` is the last
  successful listing (unchanged by a failure), `attemptAt` the last attempt. A check is due when `checkedAt` is older than
  the interval and `attemptAt` is older than one day, so a failing catalog is retried daily instead of waiting two weeks.
- Notice throttle: the notice is shown at most 3 times, then stays silent for a day (a new check result starts over).
  The state lives in `nim-notice.json` next to the cache, `{key, count, windowStart, cooldownUntil}` with
  `key` = `<checkedAt>:<new ids joined by ,>`, and is written (atomically) only when the notice is actually printed
  or appended. It is shared by every consumer, including external hooks that follow the same rule: if `key` differs,
  start from zero; stay silent while `now < cooldownUntil`; if `now - windowStart >= 24 h` (or `now < windowStart`, a clock that moved back) reset `count` and set
  `windowStart = now`; then `count += 1` and set `cooldownUntil = now + 24 h` once `count >= 3`. A missing or
  corrupt file means "show"; throttle-file errors never break a consult run.
- Both flags below work without `nim` in an order.
- `node consult-cli.js --check-nim-models` forces a check now and prints the notice (or `no new models`).
- `node consult-cli.js --refresh-nim-models` runs the throttled check in-process, silently, writing only the cache
  (this is what the detached background refresh and external hooks call).

Grok and others are in the aspirational loop but don't have bridges yet. The system is designed to add engines — each is ~30 lines in `lib/engines.js`.
