import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { runSpec, resolveQwenKey, ENGINES } from "../lib/engines.js";

const KEY = "lab-" + "k".repeat(12);
const IN_WINDOW = Date.parse("2026-10-26T15:00:00Z"); // Monday 11:00 EDT
const OUTSIDE = Date.parse("2026-10-26T22:00:00Z"); // Monday 18:00 EDT
const env = { QWEN_API_KEY: KEY, QWEN_BASE: "http://gate.test:8097/" };
const HEX32 = /^[0-9a-f]{32}$/;
const IKEY_PATH = path.join("/h", ".config", "fw13", "interactive.key");
const LAB_PATH = path.join("/h", ".config", "fw13", "lab.key");

/** fetch stub: GET /v1/models, POST chat, GET /gate/lease (release); each reply overridable. */
function fakeFetch({ model = "qwen36-test", chat, models, lease } = {}) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    if (url.endsWith("/gate/lease")) return lease ? lease() : new Response('{"ok":true}', { status: 200 });
    if (url.endsWith("/v1/models")) return models ? models() : new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200 });
    if (chat) return chat();
    return new Response(JSON.stringify({ choices: [{ message: { content: "local answer" }, finish_reason: "stop" }] }), { status: 200 });
  };
  fn.calls = calls;
  return fn;
}

const hdr = (c, n) => new Headers(c.init.headers ?? {}).get(n);
const leaseCalls = (f) => f.calls.filter((c) => c.url.endsWith("/gate/lease"));
const chatCall = (f) => f.calls.find((c) => c.url.endsWith("/v1/chat/completions"));
const ask = (f) => ENGINES.qwen({ prompt: "q", timeoutSec: 5, env, fetchImpl: f, now: OUTSIDE });
const summary = (r) => ({ ok: r.ok, engine: r.engine, body: r.body, reason: r.reason });
const enoent = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

test("A9.27 resolveQwenKey: interactive chain before the lab chain", () => {
  const files = {
    "/k/q": " a \n",
    "/k/i": "i1\n",
    [IKEY_PATH]: "i2\n",
    [LAB_PATH]: "c\n",
    [path.join("/h", "k2")]: "b\n",
  };
  const readFile = (p) => { if (p in files) return files[p]; throw enoent(); };
  assert.equal(resolveQwenKey({ env: { QWEN_API_KEY: " e " }, home: "/h", readFile }), "e");
  assert.equal(resolveQwenKey({ env: { QWEN_KEY_PATH: "/k/q" }, home: "/h", readFile }), "a");
  assert.equal(resolveQwenKey({ env: { FW13_LLM_INTERACTIVE_KEY_FILE: "/k/i" }, home: "/h", readFile }), "i1");
  assert.equal(resolveQwenKey({ env: {}, home: "/h", readFile }), "i2");
  assert.equal(resolveQwenKey({ env: { FW13_LLM_KEY_FILE: "~/k2" }, home: "/h", readFile }), "i2");
});

test("A9.28 resolveQwenKey: unreadable/empty interactive falls back to lab chain", async (t) => {
  const variants = {
    unreadable: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
    empty: () => "",
    whitespace: () => "  \n",
  };
  for (const [name, bad] of Object.entries(variants)) {
    await t.test(name, () => {
      const files = { [LAB_PATH]: "c\n", [path.join("/h", "k2")]: "b\n" };
      const readFile = (p) => {
        if (p === IKEY_PATH) return bad();
        if (p in files) return files[p];
        throw enoent();
      };
      assert.equal(resolveQwenKey({ env: {}, home: "/h", readFile }), "c");
      assert.equal(resolveQwenKey({ env: { FW13_LLM_KEY_FILE: "~/k2" }, home: "/h", readFile }), "b");
      assert.equal(resolveQwenKey({ env: { FW13_LLM_INTERACTIVE_KEY_FILE: "/missing" }, home: "/h", readFile }), "c");
    });
  }
});

test("A9.29 session token: 32 hex on models and chat, fresh per run", async () => {
  const f1 = fakeFetch();
  const f2 = fakeFetch();
  const r1 = await ask(f1);
  await ask(f2);
  const models1 = f1.calls.find((c) => c.url.endsWith("/v1/models"));
  const t1 = hdr(models1, "X-Gate-Session");
  assert.match(String(t1), HEX32);
  assert.equal(hdr(chatCall(f1), "X-Gate-Session"), t1);
  const t2 = hdr(f2.calls.find((c) => c.url.endsWith("/v1/models")), "X-Gate-Session");
  assert.match(String(t2), HEX32);
  assert.notEqual(t1, t2);
  assert.equal(r1.ok, true);
  assert.equal(r1.body, "local answer");
});

test("A9.30 release after success", async () => {
  const f = fakeFetch();
  await ask(f);
  const lc = leaseCalls(f);
  assert.equal(lc.length, 1);
  assert.equal(f.calls[f.calls.length - 1], lc[0]);
  assert.ok(lc[0].init.method === undefined || lc[0].init.method === "GET");
  assert.equal(hdr(lc[0], "X-Gate-Lease"), "release");
  assert.equal(hdr(lc[0], "X-Gate-Session"), hdr(chatCall(f), "X-Gate-Session"));
  assert.equal(hdr(lc[0], "Authorization"), `Bearer ${KEY}`);
  assert.equal(lc[0].url, "http://gate.test:8097/gate/lease");
});

test("A9.31 release on 503, models failure, network error, abort", async (t) => {
  const cases = {
    "503": { opts: { chat: () => new Response('{"error":"busy: dowtrade"}', { status: 503 }) }, reason: /^skipped: gate busy \(HTTP 503/ },
    "models failure": { opts: { models: () => new Response("x", { status: 500 }) }, ok: true }, // chat still answers on the "default" model
    "network error": { opts: { chat: () => { throw new TypeError("fetch failed"); } } },
    "abort": { opts: { chat: () => { throw new DOMException("aborted", "AbortError"); } } },
  };
  for (const [name, c] of Object.entries(cases)) {
    await t.test(name, async () => {
      const f = fakeFetch(c.opts);
      const r = await ask(f);
      assert.equal(r.ok, c.ok === true);
      if (c.reason) assert.match(r.reason, c.reason);
      const lc = leaseCalls(f);
      assert.equal(lc.length, 1);
      assert.equal(f.calls[f.calls.length - 1], lc[0]);
      const first = hdr(f.calls[0], "X-Gate-Session");
      assert.match(String(first), HEX32);
      assert.equal(hdr(lc[0], "X-Gate-Session"), first);
    });
  }
});

test("A9.32 release failure is swallowed and does not change the result", async (t) => {
  const leases = {
    "network error": () => { throw new TypeError("fetch failed"); },
    "HTTP 500": () => new Response("boom", { status: 500 }),
  };
  const chats = { success: undefined, "503": () => new Response('{"error":"busy: dowtrade"}', { status: 503 }) };
  for (const [ln, lease] of Object.entries(leases)) {
    for (const [cn, chat] of Object.entries(chats)) {
      await t.test(`${ln} / chat ${cn}`, async () => {
        const base = fakeFetch({ chat });
        const rb = await ask(base);
        assert.equal(leaseCalls(base).length, 1); // precondition: a release is attempted
        const f = fakeFetch({ chat, lease });
        const r = await ask(f);
        assert.equal(leaseCalls(f).length, 1);
        assert.deepEqual(summary(r), summary(rb));
      });
    }
  }
});

test("A9.33 reasons never contain the key or the full token", async () => {
  const f1 = fakeFetch({ chat: () => { throw new TypeError("fetch failed x"); }, lease: () => new Response("boom", { status: 500 }) });
  const f2 = fakeFetch({ chat: () => new Response('{"error":"busy: dowtrade"}', { status: 503 }), lease: () => new Response("boom", { status: 500 }) });
  for (const f of [f1, f2]) {
    const r = await ask(f);
    const token = hdr(f.calls[0], "X-Gate-Session");
    assert.match(String(token), HEX32);
    assert.equal(r.ok, false);
    assert.ok(!r.reason.includes(KEY));
    assert.ok(!r.reason.includes(token));
  }
});

test("A9.34 trading hours: interactive key still skipped, no request, no release", async () => {
  const f = fakeFetch();
  const readFile = (p) => { if (p === IKEY_PATH) return "ik\n"; throw enoent(); };
  const r = await runSpec("qwen", {
    prompt: "q", cwd: ".", timeoutSec: 5, env: { QWEN_BASE: "http://gate.test:8097/" }, home: "/h", readFile, fetchImpl: f, now: IN_WINDOW,
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "skipped: trading hours");
  assert.equal(f.calls.length, 0);
});
