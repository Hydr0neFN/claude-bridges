# CLI JSON contract (agent-mesh, claude-bridges, deckkit)

Shared by the agent-facing CLIs so a retrying agent branches on a `code`, not on prose.
Origin: OfficeCLI's structured output with stable error codes.

- Opt in with `--json` (agent-mesh, claude-bridges) or `--format json` (deckkit has both). Without it the default
  text output and its exit codes are unchanged; existing callers and hooks are not affected.
- With the flag, stdout carries exactly one JSON object and nothing else:
  `{"ok": bool, "code": "<UPPER_SNAKE>", "message": str, "data": {...}}`
  `ok:true` -> code `OK`, `data` holds the result. `ok:false` -> code names the failure, `data` may hold detail
  (e.g. `hub_code`, `status`). Logs, progress and usage text go to stderr.
- Exit codes with the flag (text mode keeps its legacy 0/1/2):
  0 ok | 1 other failure | 2 usage (bad flags/args) | 3 config (nothing configured, bad config)
  4 network (peer/hub unreachable, timeout) | 5 auth (401/403, key missing/rejected) | 6 not found (file, id, recipient)
- Codes are append-only: a code, once shipped, keeps its meaning. Common ones: OK, USAGE, NO_HUB_CONFIGURED,
  BAD_HUB_URL, HUB_UNREACHABLE, AUTH_FAILED, NOT_FOUND, HUB_<HUBCODE> (hub refused, `data.hub_code`), INTERNAL.
- Per-repo specifics (agent-mesh): `mesh send|peers|doctor|report --json`; `doctor` returns ok:false/code
  DOCTOR_WARN/exit 1 when it has warnings, with every finding in `data.findings`.
