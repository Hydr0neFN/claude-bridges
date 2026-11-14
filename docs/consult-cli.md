# consult-cli

The panel as a plain command: flags, round 2, quota locks, debate mode and update checks.

## Command line and updates

```bash
node consult-cli.js --mode all --order copilot,codex "prompt"
node consult-cli.js --copilot-model M --copilot-effort high --codex-model M --codex-effort low "prompt"
node consult-cli.js --nim-model M "prompt"       # model for the nim engine (an order entry nim:M wins over this)
node consult-cli.js --openrouter-model M "prompt" # model for the openrouter engine (an order entry openrouter:M wins over this)
node consult-cli.js --dsapi-model M "prompt"    # model for the dsapi engine (flash ids only; an order entry dsapi:M wins over this)
node consult-cli.js --check-nim-models         # force the NIM new-model check now
node consult-cli.js --prompt-file review.txt   # prompt from a file ("-" = stdin); not combinable with prompt words. Use it for long prompts such as a diff, which can exceed the OS command-line limit
node consult-cli.js --out-dir /tmp/c "prompt"   # also write <dir>/<engine>.md as each engine settles, <dir>/_done at the end (unsafe filename characters such as : and / become _)
node consult-cli.js --debate spec.json --out-dir /tmp/d   # structured debate (see "Debate mode" below); prints <dir>/digest.md and a TALLY line
node consult-cli.js --round2 /tmp/c     # round 2 of a finished --out-dir run: answering engines see each other's answers (anonymous), critique, may revise; writes /tmp/c/round2/, prints a dissent block
node consult-cli.js --locks           # list active quota locks
node consult-cli.js --unlock codex    # drop a quota lock (engine name or "all")
node consult-cli.js --ignore-locks "prompt"   # run locked engines anyway, write no new locks
node consult-cli.js --check-updates   # force a check now, print the result, exit
node consult-cli.js --update          # brew upgrade --cask <outdated CLIs>; git pull --ff-only (refuses on a dirty repo)
```

In `--mode all`, `consult-cli` prints each engine's whole `## <engine>` section (answer or `[failed] reason`) the moment it settles, in completion order, then the `[consult] mode: all | ...` summary last. Per-engine timeouts are independent, so a slow engine never delays the others. `consult-bridge` returns one aggregated result but uses the same runner (`lib/panel.js`).

## Round 2 on disagreement

A `--mode all --out-dir D` run also saves the question as `D/_prompt.md`. When the round-1 answers conflict on a decision, `consult-cli --round2 D` asks every engine that answered (needs >= 2) a second time: it sees the question, its own answer and the other answers as `Panelist N`, critiques them, and ends with `REVISED:`, `POSITION:`, `DISSENT:` lines. Output goes to `D/round2/<engine>.md` (+ `_done`) and a dissent block is printed; the caller reports that dissent, not only its own verdict. Locked engines are skipped as in round 1. `--debate` already has its own R2/R3 for stance-based questions. Implementation: `lib/round2.js`, tests `test/round2.test.js`.

## Quota locks

When `copilot`, `codex` or `agy` fails with a recognised usage/quota limit, `consult-cli` writes a lock to `~/.claude/state/consult-locks.json` (env `CONSULT_LOCKS_FILE`; outside git) and skips that engine until `until`: `{engine: {until, reason, at}}`. The summary shows `skipped: <engine>: locked until <local time> (<reason>)` and `--mode first` steps past it. `until` is the engine's own reset time when given (Codex: "try again at Nov 16th, 2026 10:54 PM", read as local time), HTTP 429 with `Retry-After`, 00:00 UTC on the 1st of next month for monthly-credit exhaustion, else +24 h for other recognised limit text. A plain 429 or any unknown error never locks. Locks expire by themselves; `--unlock <engine|all>` removes one early; `--ignore-locks` runs locked engines and writes no locks (an explicit single `--order X` honours the lock without it). Implementation: `lib/locks.js`, tests `test/locks.test.js`.

## Debate mode

`consult-cli --debate <spec.json> --out-dir <dir>` runs a deterministic debate of up to three rounds and keeps the caller's context small: the full
answers go to files, and the caller reads only `digest.md` (about 1.5k tokens for 5 engines). Spec:

```json
{ "question": "A or B?", "context": "optional inline text", "context_files": ["notes.md"],
  "word_cap": 250, "rebuttal_cap": 150, "cross_cap": 100, "rounds": 3,
  "stances": [ { "engine": "copilot", "stance": "argue for A" },
               { "engine": "deepseek", "stance": "argue for B", "fallback": ["openrouter", "nim"] } ] }
```

- Prompts are self-contained (inline `context` plus `context_files`, 20 KB per file and 60 KB total, truncation marked), because deepseek, nim and openrouter have no file access. Every reply must end with a `CLAIMS` (max 3) / `CONCEDES` / `BOTTOM LINE` block.
- Round 1: all stances run in parallel (`<dir>/r1/<engine>.md`, plus `.prompt.md`). Round 2 (`rounds: 2`): each engine that answered gets its stance plus the other engines' round-1 tail blocks (not their full text) and ends with `FINAL PICK: <option> - <reason>` (`<dir>/r2/`). Round 1 also ends with an opening `FINAL PICK`.
- Anti-herding (rounds 2 and 3): opponents appear as `Debater N` (no engine names, no vote tally, no majority hint) and the prompt says agreement is not evidence. Each reply adds `CHANGED BECAUSE:` (which Debater's claim moved it, or `unchanged`) and `WOULD CHANGE MY MIND IF:`.
- Round 3 (`rounds: 3`, default cap `cross_cap` 100 words) runs only when the R2 final picks still differ; each debater who gave a pick sees only the claims of debaters whose pick differs and answers just those (`<dir>/r3/`). Otherwise it is skipped and the digest says why. The digest also lists a per-engine pick trajectory such as `nim: D -> A -> A (R2 changed: Debater 2 claim 1)`; a pick that moved without a stated reason is flagged `NO REASON GIVEN`, and the TALLY uses each engine's latest pick. Borrowed ideas: independent first round and anonymised peers (Du et al. 2023; arXiv 2510.07517), critique-not-consensus prompting (Free-MAD, arXiv 2509.11035); papers also report plain majority voting matching debate, so the digest keeps the raw picks and trajectories rather than a judge verdict.
- A missing tail is flagged `TAIL_MISSING` (the other engines then see that engine's last ~120 words, marked), a failed engine `ENGINE_FAILED: <reason>`; one failing engine never aborts the debate. A stance's `fallback` list is tried once, on the first engine not already used, and labelled `<fallback> (for <engine>)`.
- `digest.md` holds each engine's tails and FINAL PICKs verbatim, the file paths and a `TALLY:` line; `<dir>/_done` is written last. Spec errors exit 2.

On start, both `consult-cli` and `consult-bridge` check (at most once per 24h, cache in `~/.cache/claude-bridges/updates.json`) whether the engine CLIs (`brew outdated --cask --greedy` for brew-installed casks; `copilot version` otherwise) or this repo (`git fetch`, behind-count) are outdated. The footer comes from the previous check's cached result; a stale cache is refreshed by a detached background process (CLI) or concurrently (MCP server), so a consult is never delayed or failed. It prints one footer line only when something is outdated (in the tool result for the MCP server). Nothing is installed without `--update`.

## `consult-cli.js --json`

With `--json` (prompt, `--mode all|first` or `--debate`) stdout is exactly one `{ok,code,message,data}` object instead of the text sections, with a fixed exit-code map; see `cli-json.md`. `data.engines[]` has per-engine `ok`, `code` (`OK`, `QUOTA_EXHAUSTED`, `AUTH_FAILED`, `TIMEOUT`, `NOT_INSTALLED`, `EMPTY_OUTPUT`, `CRASHED`, `ENGINE_ERROR`), `reason`, and `file` (with `--out-dir`) or `body`; `data.quota_exhausted` lists the engines that ran out of quota. Without `--json` nothing changes.
