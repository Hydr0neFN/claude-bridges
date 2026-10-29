import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as E from "../lib/engines.js";
import { parseOrder, parseOrderDetailed } from "../lib/args.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "consult-cli.js");
const DEFAULT = ["copilot", "codex", "deepseek", "agy", "nim", "openrouter"];
const OUTSIDE = Date.parse("2026-10-26T22:00:00Z");
const MOCK_KEY = "TEST_MOCK_qwen_key_0123";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cb-retire-"));

function countingServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.method + " " + req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "TEST_MOCK_qwen" }], choices: [{ message: { content: "TEST_MOCK answer" }, finish_reason: "stop" }] }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const STRIP = new Set([
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CONSULT_ORDER",
  "NIM_API_KEY", "OPENROUTER_API_KEY", "DEEPSEEK_API_KEY", "QWEN_API_KEY", "QWEN_BASE", "QWEN_KEY_PATH",
  "FW13_LLM_KEY", "FW13_LLM_KEY_FILE", "FW13_LLM_URL", "FW13_LLM_INTERACTIVE_KEY_FILE",
]);

function hermeticEnv(tmp, url) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (STRIP.has(k.toUpperCase())) delete env[k];
  const bin = path.join(tmp, "bin");
  fs.mkdirSync(bin, { recursive: true });
  Object.assign(env, { PATH: bin, HOME: tmp, USERPROFILE: tmp, APPDATA: tmp, LOCALAPPDATA: tmp });
  env.QWEN_API_KEY = MOCK_KEY;
  env.FW13_LLM_KEY = MOCK_KEY;
  env.QWEN_BASE = url;
  env.FW13_LLM_URL = url;
  env.NIM_BASE = url;
  const cfg = path.join(tmp, ".config", "fw13");
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, "lab.key"), MOCK_KEY);
  fs.writeFileSync(path.join(cfg, "interactive.key"), MOCK_KEY);
  return env;
}

function runCli(args, env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("CLI timed out after 20000ms"));
    }, 20000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

function fakeFetch() {
  const fn = async (url) => {
    fn.calls.push(String(url));
    if (String(url).endsWith("/v1/models")) {
      return new Response(JSON.stringify({ data: [{ id: "TEST_MOCK_qwen" }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: "local answer" }, finish_reason: "stop" }] }), { status: 200 });
  };
  fn.calls = [];
  return fn;
}

test("C1a.1 default order is the six engines even with qwen keys present", (t) => {
  const tmp = tmpDir();
  const lab = path.join(tmp, "lab.key");
  fs.writeFileSync(lab, MOCK_KEY);
  const saved = {
    QWEN_API_KEY: process.env.QWEN_API_KEY,
    FW13_LLM_KEY: process.env.FW13_LLM_KEY,
    FW13_LLM_KEY_FILE: process.env.FW13_LLM_KEY_FILE,
    CONSULT_ORDER: process.env.CONSULT_ORDER,
  };
  process.env.QWEN_API_KEY = MOCK_KEY;
  process.env.FW13_LLM_KEY = MOCK_KEY;
  process.env.FW13_LLM_KEY_FILE = lab;
  delete process.env.CONSULT_ORDER;
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  for (const list of [parseOrder(undefined), parseOrderDetailed(undefined).order, parseOrderDetailed("").order]) {
    assert.deepEqual(list, DEFAULT);
    assert.equal(list.includes("qwen"), false);
  }
});

test("C1a.2 consult-cli.js has no qwen (header or default-order branch)", () => {
  const text = fs.readFileSync(CLI, "utf8");
  assert.doesNotMatch(text, /qwen/i);
  assert.doesNotMatch(text, /DOWTrade window/i);
});

test("C1b.1 --order qwen exits non-zero naming qwen, no network, no output files", async (t) => {
  const tmp = tmpDir();
  const server = await countingServer();
  t.after(() => server.close());
  const env = hermeticEnv(tmp, server.url);
  const outDir = path.join(tmp, "out");

  const r = await runCli(["--order", "qwen", "--out-dir", outDir, "TEST_MOCK prompt"], env, tmp);
  assert.notEqual(r.status, 0);
  assert.notEqual(r.status, null);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /qwen/);
  assert.match(r.stderr, /removed|unknown/i);
  assert.equal(server.hits.length, 0);
  assert.equal(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, true);
});

test("C1b.2 qwen inside a list is rejected, other engines never run", async (t) => {
  const tmp = tmpDir();
  const server = await countingServer();
  t.after(() => server.close());
  const env = hermeticEnv(tmp, server.url);
  const outDir = path.join(tmp, "out");

  const r = await runCli(["--order", "copilot,qwen", "--out-dir", outDir, "TEST_MOCK prompt"], env, tmp);
  assert.notEqual(r.status, 0);
  assert.notEqual(r.status, null);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /qwen/);
  assert.match(r.stderr, /removed|unknown/i);
  assert.equal(server.hits.length, 0);
  assert.equal(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, true);
});

test("C1b.3 qwen:model form is rejected naming qwen", async (t) => {
  const tmp = tmpDir();
  const server = await countingServer();
  t.after(() => server.close());
  const env = hermeticEnv(tmp, server.url);
  const outDir = path.join(tmp, "out");

  const r = await runCli(["--order", "codex,qwen:TEST_MOCK_model", "--out-dir", outDir, "TEST_MOCK prompt"], env, tmp);
  assert.notEqual(r.status, 0);
  assert.notEqual(r.status, null);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /qwen/);
  assert.match(r.stderr, /removed|unknown/i);
  assert.equal(server.hits.length, 0);
  assert.equal(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, true);
});

test("C1b.4 --json --order qwen: one failure envelope naming qwen", async (t) => {
  const tmp = tmpDir();
  const server = await countingServer();
  t.after(() => server.close());
  const env = hermeticEnv(tmp, server.url);

  const r = await runCli(["--json", "--order", "qwen", "TEST_MOCK prompt"], env, tmp);
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout.trim().split("\n").length, 1);
  const o = JSON.parse(r.stdout.trim());
  assert.equal(o.ok, false);
  assert.notEqual(o.code, "OK");
  assert.match(o.message, /qwen/);
  assert.equal(server.hits.length, 0);
});

test("C1c.1 engines.js exports no qwen symbols and no qwen engine", () => {
  assert.deepEqual(Object.keys(E).filter((k) => /qwen/i.test(k)), []);
  assert.equal(E.ENGINE_NAMES.includes("qwen"), false);
  assert.equal(Object.hasOwn(E.ENGINES, "qwen"), false);
});

test("C1c.2 parseOrderDetailed drops qwen like any unknown engine", () => {
  assert.deepEqual(parseOrderDetailed("copilot,qwen").order, ["copilot"]);
  assert.deepEqual(parseOrderDetailed("qwen").order, []);
});

test("C1c.3 runSpec('qwen') resolves to a failure result without fetching", async () => {
  const f = fakeFetch();
  const env = { QWEN_API_KEY: MOCK_KEY, FW13_LLM_URL: "http://gate.test:8097" };
  const r = await E.runSpec("qwen", { prompt: "q", cwd: ".", timeoutSec: 5, env, fetchImpl: f, now: OUTSIDE });
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, "string");
  assert.match(r.reason, /unknown engine|removed/i);
  assert.equal(f.calls.length, 0);
});

test("C1c.4 runSpec('qwen:x') also fails soft", async () => {
  const f = fakeFetch();
  const env = { QWEN_API_KEY: MOCK_KEY, FW13_LLM_URL: "http://gate.test:8097" };
  const r = await E.runSpec("qwen:x", { prompt: "q", cwd: ".", timeoutSec: 5, env, fetchImpl: f, now: OUTSIDE });
  assert.equal(r.ok, false);
  assert.equal(typeof r.reason, "string");
  assert.match(r.reason, /unknown engine|removed|model/i);
  assert.equal(f.calls.length, 0);
});

test("C1d.1 README.md has no qwen", () => {
  const text = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.doesNotMatch(text, /qwen/i, "README.md");
});

test("C1d.2 README.zh-TW.md has no qwen", () => {
  const text = fs.readFileSync(path.join(ROOT, "README.zh-TW.md"), "utf8");
  assert.doesNotMatch(text, /qwen/i, "README.zh-TW.md");
});

test("C1d.3 consult-bridge/index.js has no qwen", () => {
  const text = fs.readFileSync(path.join(ROOT, "consult-bridge", "index.js"), "utf8");
  assert.doesNotMatch(text, /qwen/i, "consult-bridge/index.js");
});
