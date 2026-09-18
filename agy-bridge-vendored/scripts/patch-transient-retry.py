"""PATCH(agy-bridge-vendored, 2026-08-30): retry transient agy startup failures.

Problem: agy's startup eligibility check (oauth2/v2/userinfo + profile picture fetch)
intermittently fails with a network error ("Eligibility check failed: ... TLS handshake
timeout" / "... EOF"). agy exits with status ERROR, 0 turns, 0 tokens. runWithFailover
only continued the chain on QuotaError, so every other error was rethrown immediately --
no retry, no failover. From the caller's side the delegation simply produced nothing.
Failure rate rises sharply under parallel fan-out, which is exactly what heavy/long
delegations use.

Fix:
  1. classify transient agy failures (TransientError) separately from hard failures
  2. retry the SAME model with exponential backoff (AGY_RETRIES, default 2)
  3. after retries are exhausted, fall through to the next model in the chain instead of
     throwing (previously only quota did this)
  4. treat "empty output" as transient too -- that is the same failure seen from the
     other side
  5. raise the exit->close stdout drain fallback from 2s to 15s so a large stdout is not
     truncated into a spurious "empty output"

Idempotent: re-running detects the marker and exits.
"""
import re
import shutil
import sys
from pathlib import Path

DIST = Path(__file__).resolve().parent.parent / "dist" / "index.js"
MARKER = "PATCH-TRANSIENT-RETRY-20260830"

src = DIST.read_text(encoding="utf-8")
if MARKER in src:
    print("already patched")
    sys.exit(0)

backup = DIST.with_name("index.js.bak-20260830-transient")
shutil.copyfile(DIST, backup)
print(f"backup -> {backup.name}")

# ---------------------------------------------------------------- 1. config knob
old = '    onFailure: env.AGY_ON_FAILURE === "strict" ? "strict" : "fallback"'
new = ('    onFailure: env.AGY_ON_FAILURE === "strict" ? "strict" : "fallback",\n'
       '    retries: positiveInt(env.AGY_RETRIES, 2)')
assert src.count(old) == 1, "config anchor"
src = src.replace(old, new)

# ------------------------------------------------- 2. TransientError next to QuotaError
old = 'var QuotaError = class extends Error {'
new = f'''// {MARKER}: agy's startup eligibility check hits Google endpoints and fails
// intermittently under parallel load. Those failures are retryable; a hard model/prompt
// error is not. Keep them apart so only the retryable ones burn a retry.
var TRANSIENT_RE = /eligibility check failed|failed to get profile picture|tls handshake timeout|net\\/http|i\\/o timeout|connection reset|connection refused|\\bEOF\\b|context canceled|context deadline exceeded|deadline exceeded|unavailable|temporarily unavailable|\\b50[0234]\\b|oauth2|token refresh|language server shutting down/i;
function isTransient(text) {{
  return typeof text === "string" && text.length > 0 && TRANSIENT_RE.test(text);
}}
var TransientError = class extends Error {{
  constructor(model, detail) {{
    super(`agy transient failure on ${{model ?? "agy's default model"}}: ${{detail}}`);
    this.name = "TransientError";
    this.model = model;
    this.detail = detail;
  }}
  model;
  detail;
}};
var QuotaError = class extends Error {{'''
assert src.count(old) == 1, "QuotaError anchor"
src = src.replace(old, new)

# ------------------------------------------------------ 3. classify in runAgy: ERROR
old = '''          () => reject(quota ? new QuotaError(req.model, quota) : new Error(`agy failed: ${detail}`))'''
new = '''          () => reject(
            quota ? new QuotaError(req.model, quota) : isTransient(detail) ? new TransientError(req.model, detail) : new Error(`agy failed: ${detail}`)
          )'''
assert src.count(old) == 1, "ERROR-branch anchor"
src = src.replace(old, new)

# ------------------------------------------- 4. classify in runAgy: non-zero exit code
old = '''          () => reject(new Error(stderr ? `agy failed: ${stderr}` : `agy exited with code ${code}.`))'''
new = '''          () => reject(
            isTransient(stderr) ? new TransientError(req.model, stderr) : new Error(stderr ? `agy failed: ${stderr}` : `agy exited with code ${code}.`)
          )'''
assert src.count(old) == 1, "exit-code anchor"
src = src.replace(old, new)

# ------------------------------------------------- 5. classify in runAgy: empty output
old = '''            quota ? new QuotaError(req.model, quota) : new Error(
              "agy returned empty output (likely hit its print-timeout without a response)."
            )'''
new = '''            quota ? new QuotaError(req.model, quota) : new TransientError(
              req.model,
              "agy returned empty output (no result line on stdout)"
            )'''
assert src.count(old) == 1, "empty-output anchor"
src = src.replace(old, new)

# --------------------------------------------- 6. stdout drain window 2s -> 15s
old = '      closeFallback = setTimeout(() => resolve({ code: exitCode }), 2e3);'
new = ('      // ' + MARKER + ': a large stdout can still be draining when "exit" fires;\n'
       '      // 2s truncated it into a spurious empty result. Wait longer for "close".\n'
       '      closeFallback = setTimeout(() => resolve({ code: exitCode }), 15e3);')
assert src.count(old) == 1, "closeFallback anchor"
src = src.replace(old, new)

# ------------------------------------------------------- 7. retry loop in failover
old = '''    try {
      result = await runAgy(
        {
          prompt: req.prompt,
          cwd: req.cwd,
          model,
          conversationId: req.conversationId,
          timeoutSec: req.timeoutSec,
          signal: req.signal
        },
        cfg,
        deps
      );
      used = model;
      break;
    } catch (err) {
      if (err instanceof QuotaError && model) {
        cooldowns.set(model, err.resetSeconds);
        attempts.push(
          `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`
        );
        continue;
      }
      throw err;
    }
  }'''
new = '''    // ''' + MARKER + ''': retry the same model on a transient failure before moving
    // down the chain. Previously any non-quota error was rethrown on the first attempt.
    const maxRetries = cfg.retries ?? 2;
    let advanceToNextModel = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        result = await runAgy(
          {
            prompt: req.prompt,
            cwd: req.cwd,
            model,
            conversationId: req.conversationId,
            timeoutSec: req.timeoutSec,
            signal: req.signal
          },
          cfg,
          deps
        );
        used = model;
        break;
      } catch (err) {
        if (err instanceof QuotaError && model) {
          cooldowns.set(model, err.resetSeconds);
          attempts.push(
            `${model}: quota exhausted${err.resetText ? ` (resets in ${err.resetText})` : ""}`
          );
          advanceToNextModel = true;
          break;
        }
        if (err instanceof TransientError) {
          const label = model ?? "agy default";
          if (attempt < maxRetries) {
            attempts.push(`${label}: transient (${err.detail}) - retrying ${attempt + 1}/${maxRetries}`);
            await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
            continue;
          }
          attempts.push(`${label}: transient after ${maxRetries + 1} attempts (${err.detail})`);
          advanceToNextModel = true;
          break;
        }
        throw err;
      }
    }
    if (result) break;
    if (advanceToNextModel) continue;
  }'''
assert src.count(old) == 1, "failover anchor"
src = src.replace(old, new)

# ------------------------------------------- 8. better message when everything failed
old = '''      `All candidate models are quota-exhausted or cooling down:'''
new = '''      `agy produced no result. Attempts:'''
assert src.count(old) == 1, "final-error anchor"
src = src.replace(old, new)

DIST.write_text(src, encoding="utf-8")
print("patched OK")
