import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { parseArgs, parseOrder } from "../lib/args.js";
import { resolveCopilot, resolveCodex, resolveAgy, findBinary, searchDirs, NotInstalledError } from "../lib/common.js";
import { copilotRejectedModel, copilotArgs, codexArgs, launchFailure } from "../lib/engines.js";
import {
  checkUpdates, collectUpdates, formatFooter, GIT_ENV, REPO_DIR, isFresh, caskToken, parseBrewOutdated, applyUpdates, CACHE_TTL_MS, readCache,
} from "../lib/updates.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cb-test-"));

test("parseArgs: flags, prompt words, update flags", () => {
  const a = parseArgs(["--mode", "first", "--order", "codex,agy", "hello", "world", "--codex-model", "m", "--check-updates"]);
  assert.equal(a.mode, "first");
  assert.equal(a.order, "codex,agy");
  assert.equal(a.codexModel, "m");
  assert.equal(a.copilotModel, null);
  assert.equal(a.checkUpdates, true);
  assert.equal(a.update, false);
  assert.deepEqual(a.prompt, ["hello", "world"]);
});

test("parseOrder: filters unknown engines, applies default", () => {
  assert.deepEqual(parseOrder("copilot, nope ,codex"), ["copilot", "codex"]);
  assert.deepEqual(parseOrder(undefined), ["copilot", "codex", "agy"]);
});

test("searchDirs: extra dirs only off win32", () => {
  const env = { PATH: "/a:/b" };
  assert.deepEqual(searchDirs({ env, platform: "darwin", home: "/h" }), ["/a", "/b", "/opt/homebrew/bin", "/usr/local/bin", "/h/.local/bin"]);
  assert.deepEqual(searchDirs({ env, platform: "win32", home: "/h" }), ["/a", "/b"]);
});

test("resolve on darwin: PATH, thin-PATH homebrew, override, not installed", () => {
  const present = new Set(["/opt/homebrew/bin/codex", "/x/bin/copilot"]);
  const base = { platform: "darwin", home: "/h", exists: (p) => present.has(p) };
  assert.equal(resolveCopilot({ ...base, env: { PATH: "/x/bin" } }).cmd, "/x/bin/copilot");
  assert.equal(resolveCodex({ ...base, env: { PATH: "/usr/bin" } }).cmd, "/opt/homebrew/bin/codex");
  assert.equal(resolveCodex({ ...base, env: { PATH: "", CODEX_BRIDGE_BIN: "/custom/codex" } }).cmd, "/custom/codex");
  assert.throws(() => resolveAgy({ ...base, env: { PATH: "/usr/bin" } }), (e) => {
    assert.ok(e instanceof NotInstalledError);
    assert.match(e.message, /^agy: not installed \(looked in .*\/opt\/homebrew\/bin/);
    return true;
  });
  assert.equal(resolveAgy({ ...base, env: { PATH: "", AGY_PATH: "/z/agy" } }).cmd, "/z/agy");
});

test("resolve on win32: AppData fallbacks apply, no throw", () => {
  const base = { platform: "win32", home: "C:/Users/u", exists: () => false, env: { PATH: "", LOCALAPPDATA: "C:/L" } };
  assert.match(resolveCodex(base).cmd, /Programs.OpenAI.Codex.bin.codex\.exe$/);
  assert.match(resolveAgy(base).cmd, /agy.bin.agy\.exe$/);
});

test("findBinary reports searched dirs when missing", () => {
  const r = findBinary("nothing", { env: { PATH: "/q" }, platform: "linux", home: "/h", exists: () => false });
  assert.equal(r.path, null);
  assert.equal(r.searched[0], "/q");
});

test("launchFailure never leaks raw ENOENT", () => {
  const r = launchFailure("codex", Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /^not installed/);
  assert.match(launchFailure("x", new NotInstalledError("x", ["/a"])).reason, /^not installed \(looked in \/a\)$/);
});

test("copilot model fallback decision", () => {
  const rejected = { code: 1, stdout: "", stderr: 'Error: Model "gpt-5" from --model flag is not available.' };
  assert.equal(copilotRejectedModel(rejected), true);
  assert.equal(copilotRejectedModel({ ...rejected, code: 0 }), false);
  assert.equal(copilotRejectedModel({ code: 1, stdout: "", stderr: "auth failed" }), false);
});

test("model/effort flags only passed when set", () => {
  const c = copilotArgs({ prompt: "p", cwd: "/w" });
  assert.ok(!c.includes("--model") && !c.includes("--reasoning-effort"));
  const c2 = copilotArgs({ prompt: "p", cwd: "/w", model: "m", effort: "high" });
  assert.deepEqual(c2.slice(-4), ["--model", "m", "--reasoning-effort", "high"]);
  const x = codexArgs({ prompt: "p", cwd: "/w", outFile: "/o" });
  assert.ok(!x.includes("-m") && !x.includes("-c"));
  const x2 = codexArgs({ prompt: "p", cwd: "/w", outFile: "/o", model: "gpt", effort: "low" });
  assert.deepEqual(x2.slice(-4), ["-m", "gpt", "-c", 'model_reasoning_effort=low']);
});

test("footer formatting: silent when current, one line when outdated", () => {
  assert.equal(formatFooter([]), null);
  const f = formatFooter([
    { kind: "cli", name: "codex", token: "codex", current: "0.1", latest: "0.2" },
    { kind: "repo", name: "claude-bridges", behind: 1 },
  ]);
  assert.ok(!f.includes("\n"));
  assert.match(f, /codex 0\.1 -> 0\.2; claude-bridges 1 commit behind/);
  assert.match(formatFooter([{ kind: "cli", name: "copilot", token: null }]), /copilot \(update manually\)/);
});

test("brew parsing and cask token", () => {
  assert.equal(caskToken("/opt/homebrew/Caskroom/copilot-cli/1.0.94/copilot"), "copilot-cli");
  assert.equal(caskToken("/usr/local/bin/x"), null);
  const m = parseBrewOutdated(JSON.stringify({ casks: [{ name: "codex", installed_versions: ["1"], current_version: "2" }] }));
  assert.deepEqual(m.get("codex"), { current: "1", latest: "2" });
  assert.equal(parseBrewOutdated("garbage").size, 0);
});

test("update-check throttling: fresh cache skips collect, stale runs it, force overrides", async () => {
  const file = path.join(tmp(), "u.json");
  const item = [{ kind: "repo", name: "claude-bridges", behind: 2 }];
  let calls = 0;
  const collect = async () => (calls++, item);
  const t0 = 1_000_000;

  const first = checkUpdates({ file, now: t0, collect });
  assert.deepEqual(first.items, []); // nothing cached yet, result arrives via pending
  assert.deepEqual((await first.pending).items, item);
  assert.equal(calls, 1);

  const second = checkUpdates({ file, now: t0 + 1000, collect });
  assert.equal(second.fromCache, true);
  assert.deepEqual(second.items, item);
  assert.equal(calls, 1);

  checkUpdates({ file, now: t0 + CACHE_TTL_MS + 1, collect });
  assert.equal(calls, 2);
  checkUpdates({ file, now: t0 + CACHE_TTL_MS + 2, collect, force: true });
  assert.equal(calls, 3);
  assert.ok(isFresh({ checkedAt: t0 }, t0 + 5));
  assert.ok(!isFresh({ checkedAt: t0 }, t0 + CACHE_TTL_MS));
});

test("update check: stamps attempt up front and survives collector failure", async () => {
  const file = path.join(tmp(), "u.json");
  const r = checkUpdates({ file, now: 5, collect: async () => { throw new Error("boom"); } });
  assert.equal(readCache(file).checkedAt, 5);
  assert.deepEqual((await r.pending).items, []);
});

test("applyUpdates: refuses on dirty repo, upgrades casks, ff-only pull when clean", async () => {
  const log = [];
  const mk = (dirty) => async ({ cmd, args }) => {
    log.push(`${cmd} ${args.join(" ")}`);
    return { code: 0, stdout: args.includes("--porcelain") && dirty ? " M file" : "", stderr: "" };
  };
  const items = [{ kind: "cli", name: "codex", token: "codex" }, { kind: "repo", name: "claude-bridges", behind: 1 }];
  const { log: dirty, failed: dirtyFailed } = await applyUpdates({ items, run: mk(true), repoDir: "/r" });
  assert.equal(dirtyFailed, true);
  assert.ok(dirty.some((l) => /refusing to pull/.test(l)));
  assert.ok(!log.some((l) => l.includes("pull")));
  assert.ok(log.includes("brew upgrade --cask codex"));
  const { log: clean, failed: cleanFailed } = await applyUpdates({ items, run: mk(false), repoDir: "/r" });
  assert.equal(cleanFailed, false);
  assert.ok(log.includes("git -C /r pull --ff-only"));
  assert.ok(clean.some((l) => /pull --ff-only done/.test(l)));
});

import { runPanel, formatSection, summaryLine, writeEngineResult, writeDone } from "../lib/panel.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fake = (delays) => async (name) => {
  await sleep(delays[name][0]);
  return delays[name][1] ? { engine: name, ok: true, body: `${name} body` } : { engine: name, ok: false, reason: "quota" };
};

test("runPanel: onSettle fires in completion order, results keep input order", async () => {
  const seen = [];
  const results = await runPanel({
    order: ["slow", "mid", "fast"],
    run: fake({ slow: [60, true], mid: [30, false], fast: [5, true] }),
    onSettle: (n) => seen.push(n),
  });
  assert.deepEqual(seen, ["fast", "mid", "slow"]);
  assert.deepEqual(results.map((r) => r.engine), ["slow", "mid", "fast"]);
});

test("runPanel: a hung engine does not delay the others' output", async () => {
  const t0 = Date.now();
  const at = {};
  const p = runPanel({
    order: ["hung", "fast"],
    run: (n) => (n === "hung" ? sleep(150).then(() => ({ engine: n, ok: false, reason: "timed out after 0.15s" })) : fake({ fast: [5, true] })(n)),
    onSettle: (n) => (at[n] = Date.now() - t0),
  });
  await p;
  assert.ok(at.fast < 100 && at.hung >= 140, JSON.stringify(at));
});

test("runPanel: crashing engine and failing sink are contained", async () => {
  const r = await runPanel({
    order: ["a", "b"],
    run: async (n) => { if (n === "a") throw new Error("x"); return { engine: n, ok: true, body: "ok" }; },
    onSettle: () => { throw new Error("sink"); },
  });
  assert.match(r[0].reason, /^crashed: x/);
  assert.equal(r[1].ok, true);
});

test("sections and summary formatting", () => {
  const ok = { engine: "codex", ok: true, body: "hi" };
  const bad = { engine: "agy", ok: false, reason: "timed out after 5s" };
  assert.equal(formatSection(ok), "## codex\n\nhi\n");
  assert.equal(formatSection(bad), "## agy\n\n[failed] timed out after 5s\n");
  assert.equal(summaryLine([ok, bad]), "[consult] mode: all | answered: codex | failed: agy: timed out after 5s");
  assert.equal(summaryLine([bad]), null);
});

test("out-dir: engine files appear as each settles, _done only at the end", async () => {
  const dir = path.join(tmp(), "out");
  const snaps = [];
  const results = await runPanel({
    order: ["slow", "fast"],
    run: fake({ slow: [50, true], fast: [5, true] }),
    onSettle: (n, r) => { writeEngineResult(dir, n, r); snaps.push(fs.readdirSync(dir).sort()); },
  });
  assert.deepEqual(snaps[0], ["fast.md"]);
  assert.deepEqual(snaps[1], ["fast.md", "slow.md"]);
  assert.ok(!fs.existsSync(path.join(dir, "_done")));
  writeDone(dir, summaryLine(results));
  assert.match(fs.readFileSync(path.join(dir, "_done"), "utf8"), /answered: slow, fast/);
  assert.equal(fs.readFileSync(path.join(dir, "fast.md"), "utf8"), "## fast\n\nfast body\n");
});

test("parseArgs: --out-dir", () => {
  assert.equal(parseArgs(["--out-dir", "/o", "p"]).outDir, "/o");
});

test("parseArgs: Object.prototype names are prompt words, not flags", () => {
  assert.deepEqual(parseArgs(["fix", "toString", "in", "constructor", "class", "__proto__", "hasOwnProperty"]).prompt,
    ["fix", "toString", "in", "constructor", "class", "__proto__", "hasOwnProperty"]);
});

test("collectUpdates: brew outdated uses --greedy (auto_updates casks) and git gets non-interactive env", async () => {
  const calls = [];
  const run = async (o) => {
    calls.push(o);
    if (o.cmd === "brew") return { code: 0, stderr: "", stdout: JSON.stringify({ casks: [{ name: "copilot-cli", installed_versions: ["1.0.94"], current_version: "1.1.0" }] }) };
    return { code: 0, stdout: "0", stderr: "" };
  };
  const items = await collectUpdates({
    run,
    repoDir: "/r",
    resolvers: { copilot: () => ({ cmd: "/opt/homebrew/bin/copilot", pre: [] }) },
    realpath: () => "/opt/homebrew/Caskroom/copilot-cli/1.0.94/copilot",
  });
  assert.deepEqual(items, [{ kind: "cli", name: "copilot", token: "copilot-cli", current: "1.0.94", latest: "1.1.0" }]);
  assert.ok(calls.find((c) => c.cmd === "brew").args.includes("--greedy"));
  assert.deepEqual(calls.find((c) => c.args.includes("fetch")).env, GIT_ENV);
});

test("checkUpdates detach: stale cache -> detached refresh, cached items returned, nothing awaited", () => {
  const file = path.join(tmp(), "u.json");
  fs.writeFileSync(file, JSON.stringify({ checkedAt: 1, items: [{ kind: "repo", name: "claude-bridges", behind: 1 }] }));
  let spawned = null;
  const r = checkUpdates({ file, now: CACHE_TTL_MS * 3, detach: (f) => (spawned = f), collect: () => assert.fail("must not collect in-process") });
  assert.equal(spawned, file);
  assert.equal(r.items.length, 1);
  // fresh cache: no refresh
  spawned = null;
  checkUpdates({ file, now: CACHE_TTL_MS * 3 + 5, detach: (f) => (spawned = f) });
  assert.equal(spawned, null);
});

test("footer command is an absolute path", () => {
  assert.ok(formatFooter([{ kind: "repo", name: "claude-bridges", behind: 2 }]).includes(`node ${path.join(REPO_DIR, "consult-cli.js")} --update`));
});
