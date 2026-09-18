// Verifies the patched agy-bridge bundle by evaluating ITS OWN parseModels/normModel/
// canonicalize implementations against live `agy models` output — the exact predicate
// resolveChain uses. Does not re-implement the logic.
import { readFile } from "fs/promises";
import { execFileSync } from "child_process";

const BUNDLE = process.env.HOME + "/claude-bridges/agy-bridge-vendored/dist/index.js";
const src = await readFile(BUNDLE, "utf8");

const grab = (name) => {
  const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(src);
  if (!m) throw new Error(`could not extract ${name}() from bundle`);
  return m[0];
};

const { parseModels, normModel, canonicalize } = new Function(
  `${grab("parseModels")}\n${grab("normModel")}\n${grab("canonicalize")}
   return { parseModels, normModel, canonicalize };`
)();

const available = parseModels(execFileSync("agy", ["models"], { encoding: "utf8" }));
console.log("available models:", available.length, "\n");

const chains = [...src.matchAll(/chain: (\[[^\]]*\])/g)].map((m) => JSON.parse(m[1]));
let bad = 0;
for (const chain of chains) {
  if (chain.length === 0) continue; // follow_up: intentionally empty
  for (const entry of chain) {
    const hit = canonicalize(entry, available);
    if (hit) console.log(`  OK   ${entry} -> ${hit}`);
    else { console.log(`  FAIL ${entry} -> NO MATCH`); bad++; }
  }
}

// Regression guard: the old display-name spelling must still resolve (normalization works).
const legacy = canonicalize("Gemini 3.6 Flash (High)", available);
console.log(`\nlegacy display-name form -> ${legacy ?? "NO MATCH"}`);
if (!legacy) bad++;

console.log(bad === 0 ? "\nALL CHAINS RESOLVE" : `\n${bad} UNRESOLVED`);

// ---------------------------------------------------------------------------
// Patch 3 guard: prompt must travel on stdin, never on argv.
// ---------------------------------------------------------------------------
console.log("\n-- stdin / stream-json --");
const { buildArgs, buildStdin, parseStreamResult } = new Function(
  `${grab("buildArgs")}\n${grab("buildStdin")}\n${grab("parseStreamResult")}
   return { buildArgs, buildStdin, parseStreamResult };`
)();

const SENTINEL = "PROMPT-MUST-NOT-REACH-ARGV";
const args = buildArgs(
  { prompt: SENTINEL, cwd: "C:/tmp", timeoutSec: 60 },
  { skipPermissions: false, sandbox: false, timeoutSec: 60 },
  "C:/tmp/x.log"
);
const check = (label, ok) => {
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}`);
  if (!ok) bad++;
};
check("argv carries --input-format stream-json", args.join(" ").includes("--input-format stream-json"));
check("argv carries --output-format stream-json", args.join(" ").includes("--output-format stream-json"));
check("prompt is NOT in argv", !args.some((a) => String(a).includes(SENTINEL)));
check("stdin envelope carries the prompt", JSON.parse(buildStdin(SENTINEL)).message.content[0].text === SENTINEL);

const sample = [
  '{"event":"init","conversation_id":"abc"}',
  '{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"hello","duration_seconds":1.5,"usage":{"input_tokens":10,"output_tokens":2}}}',
].join("\n");
const parsed = parseStreamResult(sample);
check("result envelope parsed", parsed.parsed === true && parsed.response === "hello");
check("conversationId lifted from envelope", parsed.conversationId === "conv-1");
check("usage lifted from envelope", parsed.usage?.input_tokens === 10);
const fallback = parseStreamResult("not json at all");
check("falls back to raw stdout on unparseable output", fallback.parsed === false && fallback.response === "not json at all");

// Quota strings must still be detected in the envelope's error field, not just the log.
const grabVar = (name) => {
  const m = new RegExp(`var ${name} = .*`).exec(src);
  if (!m) throw new Error(`could not extract var ${name} from bundle`);
  return m[0];
};
const { detectQuota } = new Function(
  `${grabVar("QUOTA_RE")}
${grabVar("RESET_RE")}
${grab("parseResetDuration")}
${grab("detectQuota")}
   return { detectQuota };`
)();
check(
  "quota detected from envelope error text",
  !!detectQuota("model overloaded: RESOURCE_EXHAUSTED (code 429). Resets in 12m30s")
);

// ---------------------------------------------------------------------------
// Patch 4 guard: background job tools registered and worker entry present.
// ---------------------------------------------------------------------------
console.log("\n-- background jobs --");
for (const name of ["delegate_async", "job_status", "job_result", "job_cancel"]) {
  check(`tool ${name} declared`, new RegExp(`name: "${name}"`).test(src));
}
check("JOB_TOOLS registered on the server", /for \(const tool of JOB_TOOLS\)/.test(src));
check("--job-worker entry branch present", /process\.argv\[2\] === "--job-worker"/.test(src));
check("worker survives parent exit (detached: true)", /"--job-worker", jobPath\(cwd, job\.id\)\][\s\S]{0,120}detached: true/.test(src));
check("cancel kills the whole process tree", /taskkill\.exe/.test(src) && /"\/T", "\/F"/.test(src));

console.log(bad === 0 ? "\nALL CHECKS PASS" : `\n${bad} FAILURES`);
process.exit(bad === 0 ? 0 : 1);
