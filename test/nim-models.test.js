import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  refreshNimModels, peekNimModels, formatNimNotice, nimTtlMs, nimCachePath, readNimCache, orderUsesNim, NIM_NON_CHAT_RE,
} from "../lib/nim-models.js";

// Built at runtime so no key-shaped literal lands in the repo.
const FAKE_KEY = "nv" + "api-" + "x".repeat(20);

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 10);
const modelsRes = (ids) => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });

/** fetch stub returning `list()`; records every call. */
function listFetch(list) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, method: init?.method || "GET" });
    return list();
  };
  fn.calls = calls;
  return fn;
}

function ctx() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-nimm-"));
  return { dir, file: path.join(dir, "nim-models.json"), env: { NIM_API_KEY: FAKE_KEY, CLAUDE_BRIDGES_CACHE_DIR: dir }, home: dir };
}
const noKeyFile = () => {
  throw new Error("no key file");
};

test("baseline run records seen and produces no notice", async () => {
  const c = ctx();
  const f = listFetch(() => modelsRes(["a/one", "b/two"]));
  const { skipped, cache } = await refreshNimModels({ ...c, now: T0, fetchImpl: f });
  assert.equal(skipped, null);
  assert.deepEqual(cache, { checkedAt: T0, attemptAt: T0, baselineAt: T0, seen: ["a/one", "b/two"], new: [], error: null });
  assert.deepEqual(readNimCache(c.file), cache);
  assert.equal(formatNimNotice(cache), null);
});

test("only GET /v1/models is requested: no chat calls, bearer auth", async () => {
  const c = ctx();
  await refreshNimModels({ ...c, now: T0, fetchImpl: listFetch(() => modelsRes(["old/m"])) });
  const f = listFetch(() => modelsRes(["old/m", "new/a", "new/b"]));
  await refreshNimModels({ ...c, now: T0 + 15 * DAY, fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "https://integrate.api.nvidia.com/v1/models");
  assert.equal(f.calls[0].method, "GET");
  assert.equal(f.calls[0].init.body, undefined);
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${FAKE_KEY}`);
});

test("no key writes nothing; a fresh cache skips the network; force overrides", async () => {
  const c = ctx();
  const f = listFetch(() => modelsRes(["a"]));
  const none = await refreshNimModels({ ...c, env: { CLAUDE_BRIDGES_CACHE_DIR: c.dir }, readFile: noKeyFile, fetchImpl: f });
  assert.equal(none.skipped, "no key");
  assert.ok(!fs.existsSync(c.file));
  await refreshNimModels({ ...c, now: T0, fetchImpl: f });
  const again = await refreshNimModels({ ...c, now: T0 + DAY, fetchImpl: f });
  assert.equal(again.skipped, "fresh");
  assert.equal(f.calls.length, 1);
  const forced = await refreshNimModels({ ...c, now: T0 + DAY, fetchImpl: f, force: true });
  assert.equal(forced.skipped, null);
  assert.equal(f.calls.length, 2);
});

test("later run lists new chat ids, filters non-chat, remembers everything", async () => {
  const c = ctx();
  await refreshNimModels({ ...c, now: T0, fetchImpl: listFetch(() => modelsRes(["old/m"])) });
  const f = listFetch(() => modelsRes(["old/m", "new/b", "nvidia/nv-embed-v1", "new/a", "x/llama-guard", "y/whisper-large"]));
  const { cache } = await refreshNimModels({ ...c, now: T0 + 15 * DAY, fetchImpl: f });
  assert.deepEqual(cache.new, ["new/b", "new/a"]);
  assert.deepEqual(cache.seen, ["old/m", "new/b", "nvidia/nv-embed-v1", "new/a", "x/llama-guard", "y/whisper-large"]);
  assert.equal(cache.baselineAt, T0);
  assert.equal(cache.checkedAt, T0 + 15 * DAY);
  assert.equal(
    formatNimNotice(cache),
    "[consult] NIM: 2 new models since 2026-10-25: new/b, new/a -> worth a look in a separate session; try --order nim:<id>",
  );

  // Next check: those ids are now seen, so `new` is replaced by an empty list.
  const next = await refreshNimModels({ ...c, now: T0 + 30 * DAY, fetchImpl: listFetch(() => modelsRes(cache.seen)) });
  assert.deepEqual(next.cache.new, []);
  assert.equal(formatNimNotice(next.cache), null);
});

test("listing failure keeps old state and checkedAt, records a redacted error, retries daily", async () => {
  const c = ctx();
  const first = await refreshNimModels({ ...c, now: T0, fetchImpl: listFetch(() => modelsRes(["a", "b"])) });
  const bad = listFetch(() => new Response(`denied for ${FAKE_KEY}`, { status: 401 }));
  const { cache } = await refreshNimModels({ ...c, now: T0 + 15 * DAY, fetchImpl: bad });
  assert.deepEqual(cache.seen, first.cache.seen);
  assert.deepEqual(cache.new, []);
  assert.equal(cache.checkedAt, T0, "checkedAt is the last SUCCESS");
  assert.equal(cache.attemptAt, T0 + 15 * DAY);
  assert.match(cache.error, /^listing failed: HTTP 401: denied for nvapi-\*\*\*$/);
  assert.ok(!fs.readFileSync(c.file, "utf8").includes(FAKE_KEY));
  // Attempt stamped: no stampede inside a day...
  const again = await refreshNimModels({ ...c, now: T0 + 15 * DAY + DAY / 2, fetchImpl: bad });
  assert.equal(again.skipped, "fresh");
  assert.equal(bad.calls.length, 1);
  // ...but a failure does not silence checks for a whole TTL: it retries after a day.
  const retried = await refreshNimModels({ ...c, now: T0 + 16 * DAY, fetchImpl: bad });
  assert.equal(retried.skipped, null);
  assert.equal(bad.calls.length, 2);
  // A later success clears the error and advances checkedAt.
  const ok = await refreshNimModels({ ...c, now: T0 + 17 * DAY, fetchImpl: listFetch(() => modelsRes(["a", "b"])) });
  assert.equal(ok.cache.error, null);
  assert.equal(ok.cache.checkedAt, T0 + 17 * DAY);
});

test("a network or empty listing is an error, never a wipe of seen", async () => {
  const c = ctx();
  await refreshNimModels({ ...c, now: T0, fetchImpl: listFetch(() => modelsRes(["a"])) });
  const r = await refreshNimModels({ ...c, now: T0 + 15 * DAY, fetchImpl: listFetch(() => modelsRes([])) });
  assert.deepEqual(r.cache.seen, ["a"]);
  assert.equal(r.cache.error, "listing failed: empty model list");
  const boom = async () => {
    throw Object.assign(new Error("t"), { name: "TimeoutError" });
  };
  const t = await refreshNimModels({ ...c, now: T0 + 30 * DAY, fetchImpl: boom });
  assert.equal(t.cache.error, "listing failed: timed out after 30s");
  assert.deepEqual(t.cache.seen, ["a"]);
});

test("first-ever listing failing is retried after a day, not a TTL", async () => {
  const c = ctx();
  const bad = listFetch(() => new Response("down", { status: 503 }));
  const first = await refreshNimModels({ ...c, now: T0, fetchImpl: bad });
  assert.equal(first.cache.checkedAt, 0);
  assert.deepEqual(first.cache.seen, []);
  assert.equal((await refreshNimModels({ ...c, now: T0 + DAY / 2, fetchImpl: bad })).skipped, "fresh");
  const ok = await refreshNimModels({ ...c, now: T0 + DAY, fetchImpl: listFetch(() => modelsRes(["a"])) });
  assert.deepEqual(ok.cache, { checkedAt: T0 + DAY, attemptAt: T0 + DAY, baselineAt: T0 + DAY, seen: ["a"], new: [], error: null });
});

test("TTL: default 14 days, env override only when positive", () => {
  assert.equal(nimTtlMs({}), 14 * DAY);
  assert.equal(nimTtlMs({ NIM_MODELS_CHECK_DAYS: "7" }), 7 * DAY);
  assert.equal(nimTtlMs({ NIM_MODELS_CHECK_DAYS: "0.5" }), DAY / 2);
  assert.equal(nimTtlMs({ NIM_MODELS_CHECK_DAYS: "0" }), 14 * DAY);
  assert.equal(nimTtlMs({ NIM_MODELS_CHECK_DAYS: "abc" }), 14 * DAY);
});

test("peek: spawns a refresh only when stale and a key exists", async () => {
  const c = ctx();
  let spawned = 0;
  const detach = () => spawned++;
  peekNimModels({ ...c, now: T0, detach });
  assert.equal(spawned, 1, "no cache + key -> refresh");
  await refreshNimModels({ ...c, now: T0, fetchImpl: listFetch(() => modelsRes(["a"])) });
  peekNimModels({ ...c, now: T0 + 13 * DAY, detach });
  assert.equal(spawned, 1);
  peekNimModels({ ...c, now: T0 + 15 * DAY, detach });
  assert.equal(spawned, 2);
  peekNimModels({ ...c, now: T0 + 8 * DAY, env: { ...c.env, NIM_MODELS_CHECK_DAYS: "7" }, detach });
  assert.equal(spawned, 3);
  // After a failed listing the attempt stamp throttles spawns to once a day.
  await refreshNimModels({ ...c, now: T0 + 20 * DAY, fetchImpl: listFetch(() => new Response("x", { status: 500 })) });
  peekNimModels({ ...c, now: T0 + 20 * DAY + DAY / 2, detach });
  assert.equal(spawned, 3);
  peekNimModels({ ...c, now: T0 + 21 * DAY, detach });
  assert.equal(spawned, 4);
  peekNimModels({ ...c, now: T0 + 99 * DAY, env: { CLAUDE_BRIDGES_CACHE_DIR: c.dir }, readFile: noKeyFile, detach });
  assert.equal(spawned, 4, "no key -> never spawn");
});

test("orderUsesNim: bare nim or nim:<model> only", () => {
  assert.equal(orderUsesNim(["copilot", "nim"]), true);
  assert.equal(orderUsesNim(["codex", "nim:moonshotai/kimi-k3"]), true);
  assert.equal(orderUsesNim(["copilot", "codex", "agy", "deepseek:nim"]), false);
  assert.equal(orderUsesNim([]), false);
  assert.equal(orderUsesNim(undefined), false);
});

test("cache path follows the cache-dir convention; non-chat regex", () => {
  assert.equal(nimCachePath({ CLAUDE_BRIDGES_CACHE_DIR: "/c" }, "/h"), path.join("/c", "nim-models.json"));
  assert.equal(nimCachePath({}, "/h"), path.join("/h", ".cache", "claude-bridges", "nim-models.json"));
  for (const id of ["nvidia/nv-embedqa-e5", "x/rerank-1", "meta/llama-guard-4", "a/nemoretriever-ocr", "n/reward-model", "openai/whisper-large-v3", "a/clip-vit", "x/parse-1"]) {
    assert.ok(NIM_NON_CHAT_RE.test(id), id);
  }
  assert.ok(!NIM_NON_CHAT_RE.test("moonshotai/kimi-k3"));
});

test("formatNimNotice: null cases, singular, and the 6-id cap", () => {
  assert.equal(formatNimNotice(null), null);
  assert.equal(formatNimNotice({ checkedAt: T0, new: [] }), null);
  assert.equal(
    formatNimNotice({ checkedAt: T0, new: ["a/b"] }),
    "[consult] NIM: 1 new model since 2026-10-10: a/b -> worth a look in a separate session; try --order nim:<id>",
  );
  const ids = Array.from({ length: 9 }, (_, i) => `m/${i}`);
  assert.equal(
    formatNimNotice({ checkedAt: T0, new: ids }),
    "[consult] NIM: 9 new models since 2026-10-10: m/0, m/1, m/2, m/3, m/4, m/5 (+3 more) -> worth a look in a separate session; try --order nim:<id>",
  );
});

test("the cache never contains the key", async () => {
  const c = ctx();
  await refreshNimModels({ ...c, now: T0, fetchImpl: listFetch(() => modelsRes(["old/m"])) });
  await refreshNimModels({ ...c, now: T0 + 15 * DAY, fetchImpl: listFetch(() => new Response(`bad ${FAKE_KEY}`, { status: 500 })) });
  await refreshNimModels({ ...c, now: T0 + 30 * DAY, fetchImpl: listFetch(() => modelsRes(["old/m", "n/m"])) });
  const raw = fs.readFileSync(c.file, "utf8");
  assert.ok(!raw.includes(FAKE_KEY));
  assert.ok(!raw.includes("x".repeat(20)));
  assert.deepEqual(JSON.parse(raw).new, ["n/m"]);
});

// ---- consult-cli.js as a child process (scratch cache dir, no real key, no real network) ----
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "consult-cli.js");

function runCli(args, extraEnv, cacheDir) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CLAUDE_BRIDGES_CACHE_DIR: cacheDir, ...extraEnv };
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8", timeout: 60000 });
}

test("cli --refresh-nim-models: silent, exit 0, writes only the cache, ignores prompt words", () => {
  for (const extra of [[], ["review", "this", "diff"]]) {
    const c = ctx();
    const r = runCli(["--refresh-nim-models", ...extra], { NIM_API_KEY: FAKE_KEY, NIM_BASE: "http://127.0.0.1:9" }, c.dir);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, "");
    // It ran the check (unreachable base -> recorded error) and nothing else: no panel output, no update cache.
    assert.match(readNimCache(c.file).error, /^listing failed: /);
    assert.ok(!fs.readFileSync(c.file, "utf8").includes(FAKE_KEY));
    assert.deepEqual(fs.readdirSync(c.dir), ["nim-models.json"]);
  }
});

test("cli --check-nim-models: no key exits 0 even when an older cache carries an error", () => {
  const c = ctx();
  fs.writeFileSync(c.file, JSON.stringify({ checkedAt: T0, attemptAt: T0, baselineAt: T0, seen: ["a"], new: [], error: "listing failed: old" }));
  const r = runCli(["--check-nim-models"], { NIM_KEY_PATH: path.join(c.dir, "no-such-key") }, c.dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no key configured/);
});
