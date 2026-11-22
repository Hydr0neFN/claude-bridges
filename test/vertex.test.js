import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { parseOrderDetailed, parseArgs } from "../lib/args.js";
import { runPanel, writeEngineResult } from "../lib/panel.js";
import { validateSpec } from "../lib/debate.js";
import {
  ENGINES,
  MODEL_ENGINES,
  DEFAULT_VERTEX_MODEL,
  isVertexModel,
  vertexModel,
  vertexMaxTokens,
  vertexTimeoutSec,
  resetVertexTokenCache,
  runSpec,
  panelModels,
} from "../lib/engines.js";

// Ephemeral RSA keypair generated at runtime so no key-shaped literal lands in the repo.
const { publicKey: PUB_KEY, privateKey: PRIV_KEY_OBJ } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIV_KEY = PRIV_KEY_OBJ.export({ type: "pkcs8", format: "pem" });
const CLIENT_EMAIL = "consult-sa@demo-proj.iam.gserviceaccount.com";
const PROJECT_ID = "demo-proj";
const KEY_JSON = JSON.stringify({
  type: "service_account",
  project_id: PROJECT_ID,
  client_email: CLIENT_EMAIL,
  private_key: PRIV_KEY,
});
const TOKEN = "ya29." + "v".repeat(40);
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CHAT_URL = (proj = PROJECT_ID) =>
  `https://aiplatform.googleapis.com/v1/projects/${proj}/locations/global/endpoints/openapi/chat/completions`;

const noFile = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};

const tokenResp = (access_token = TOKEN, expires_in = 3600) => () =>
  new Response(JSON.stringify({ access_token, expires_in, token_type: "Bearer" }), { status: 200 });

const chatResp = (message) => () =>
  new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }), { status: 200 });

const statusResp = (code, body = "", headers = {}) => () =>
  new Response(body, { status: code, headers });

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init, rawBody: init?.body });
    return responses[Math.min(calls.length, responses.length) - 1]();
  };
  fn.calls = calls;
  return fn;
}

const readKeyFromHome = (keyContent = KEY_JSON, keyPath = path.join("/h", ".gcp-vertex-key.json")) => (p) =>
  p === keyPath ? keyContent : noFile();

const run = (fetchImpl, extra = {}) =>
  ENGINES.vertex({
    prompt: "hi",
    env: {},
    home: "/h",
    readFile: readKeyFromHome(),
    fetchImpl,
    ...extra,
  });

const NOW_MS = Date.parse("2026-11-22T12:00:00Z");

test("vertex: OAuth token request body, RS256 JWT header/claims/signature, and chat request shape", async () => {
  resetVertexTokenCache();
  const f = fakeFetch([
    tokenResp(TOKEN, 3600),
    chatResp({ content: " vertex ok \n", extra_content: { thought_signature: "ignore-me" } }),
  ]);
  const r = await run(f, { now: NOW_MS });
  assert.deepEqual(r, { engine: "vertex:google/gemini-4-neon", ok: true, body: "vertex ok" });
  assert.equal(f.calls.length, 2);

  // 1. Token exchange call
  const tokCall = f.calls[0];
  assert.equal(tokCall.url, TOKEN_URL);
  assert.equal(tokCall.init.method, "POST");
  assert.equal(tokCall.init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.ok(tokCall.rawBody.startsWith("grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion="));
  const params = new URLSearchParams(tokCall.rawBody);
  assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
  const assertion = params.get("assertion");
  const parts = assertion.split(".");
  assert.equal(parts.length, 3);
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  assert.deepEqual(header, { alg: "RS256", typ: "JWT" });
  assert.equal(claims.iss, CLIENT_EMAIL);
  assert.equal(claims.scope, "https://www.googleapis.com/auth/cloud-platform");
  assert.equal(claims.aud, TOKEN_URL);
  assert.equal(claims.iat, Math.floor(NOW_MS / 1000));
  assert.equal(claims.exp, claims.iat + 3600);
  const validSig = cryptoVerify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    PUB_KEY,
    Buffer.from(parts[2], "base64url"),
  );
  assert.equal(validSig, true, "RS256 signature must verify against public key");

  // 2. Chat completions call
  const chatCall = f.calls[1];
  assert.equal(chatCall.url, CHAT_URL(PROJECT_ID));
  assert.equal(chatCall.init.method, "POST");
  assert.equal(chatCall.init.headers["Content-Type"], "application/json");
  assert.equal(chatCall.init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(chatCall.rawBody), {
    model: "google/gemini-4-neon",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 16000,
  });
});

test("vertex: token is cached in memory and refreshed 5 minutes before expiry", async () => {
  resetVertexTokenCache();
  let t = NOW_MS;
  const f = fakeFetch([
    tokenResp("ya29.first-token-123456", 3600),
    chatResp({ content: "one" }),
    chatResp({ content: "two" }),
    tokenResp("ya29.second-token-789012", 3600),
    chatResp({ content: "three" }),
  ]);

  const r1 = await run(f, { now: () => t });
  assert.equal(r1.body, "one");
  assert.equal(f.calls.length, 2);

  // 54 minutes later (6 minutes before expiry): still cached, no token call
  t = NOW_MS + 54 * 60 * 1000;
  const r2 = await run(f, { now: () => t });
  assert.equal(r2.body, "two");
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].init.headers.Authorization, "Bearer ya29.first-token-123456");

  // 55 minutes later (5 minutes before expiry): refreshes token
  t = NOW_MS + 55 * 60 * 1000;
  const r3 = await run(f, { now: () => t });
  assert.equal(r3.body, "three");
  assert.equal(f.calls.length, 5);
  assert.equal(f.calls[3].url, TOKEN_URL);
  assert.equal(f.calls[4].init.headers.Authorization, "Bearer ya29.second-token-789012");
});

test("vertex: VERTEX_KEY_FILE, VERTEX_PROJECT, VERTEX_MAX_TOKENS, and VERTEX_TIMEOUT", async () => {
  resetVertexTokenCache();
  const customKeyPath = path.join("/custom", "sa.json");
  const keyNoProj = JSON.stringify({ client_email: CLIENT_EMAIL, private_key: PRIV_KEY });
  const f = fakeFetch([tokenResp(), chatResp({ content: "ok" })]);
  const r = await ENGINES.vertex({
    prompt: "hi",
    env: { VERTEX_KEY_FILE: customKeyPath, VERTEX_PROJECT: "override-proj", VERTEX_MAX_TOKENS: "4096" },
    home: "/h",
    readFile: (p) => (p === customKeyPath ? keyNoProj : noFile()),
    fetchImpl: f,
    now: NOW_MS,
  });
  assert.equal(r.ok, true);
  assert.equal(f.calls[1].url, CHAT_URL("override-proj"));
  assert.equal(JSON.parse(f.calls[1].rawBody).max_tokens, 4096);

  assert.equal(vertexMaxTokens({}), 16000);
  assert.equal(vertexMaxTokens({ VERTEX_MAX_TOKENS: "2048" }), 2048);
  assert.equal(vertexMaxTokens({ VERTEX_MAX_TOKENS: "abc" }), 16000);
  assert.equal(vertexMaxTokens({ VERTEX_MAX_TOKENS: "-10" }), 16000);

  assert.equal(vertexTimeoutSec({}), 300);
  assert.equal(vertexTimeoutSec({ VERTEX_TIMEOUT: "120" }), 120);
  assert.equal(vertexTimeoutSec({ VERTEX_TIMEOUT: "9999" }), 600);
  assert.equal(vertexTimeoutSec({ VERTEX_TIMEOUT: "-5" }), 300);
});

test("vertex: model resolution precedence (spec > flag > VERTEX_MODEL > default) and shape validation", async () => {
  resetVertexTokenCache();
  assert.equal(DEFAULT_VERTEX_MODEL, "google/gemini-4-neon");
  assert.equal(vertexModel(undefined, {}), "google/gemini-4-neon");
  assert.equal(vertexModel(undefined, { VERTEX_MODEL: "zai-org/glm-5.2-maas" }), "zai-org/glm-5.2-maas");
  assert.equal(vertexModel("meta/llama-4", { VERTEX_MODEL: "zai-org/glm-5.2-maas" }), "meta/llama-4");

  assert.equal(isVertexModel("google/gemini-4-neon"), true);
  assert.equal(isVertexModel("zai-org/glm-5.2-maas"), true);
  assert.equal(isVertexModel("a-1/b_2.3-c"), true);
  for (const bad of ["", "gemini-4-neon", "Google/gemini", "a/b/c", "a/b c", "../x", "a/"]) {
    assert.equal(isVertexModel(bad), false, bad);
  }

  const f = fakeFetch([tokenResp(), chatResp({ content: "ok" })]);
  const rSpec = await runSpec(
    "vertex:zai-org/glm-5.2-maas",
    { prompt: "hi", env: { VERTEX_MODEL: "meta/from-env" }, home: "/h", readFile: readKeyFromHome(), fetchImpl: f, now: NOW_MS },
    { vertex: { model: "meta/from-flag" } },
  );
  assert.equal(rSpec.engine, "vertex:zai-org/glm-5.2-maas");
  assert.equal(JSON.parse(f.calls[1].rawBody).model, "zai-org/glm-5.2-maas");

  const fFlag = fakeFetch([chatResp({ content: "ok" })]);
  const rFlag = await runSpec(
    "vertex",
    { prompt: "hi", env: { VERTEX_MODEL: "meta/from-env" }, home: "/h", readFile: readKeyFromHome(), fetchImpl: fFlag, now: NOW_MS },
    { vertex: { model: "meta/from-flag" } },
  );
  assert.equal(rFlag.engine, "vertex:meta/from-flag");
  assert.equal(JSON.parse(fFlag.calls[0].rawBody).model, "meta/from-flag");

  const fBad = fakeFetch([tokenResp(), chatResp({ content: "ok" })]);
  const rBad = await run(fBad, { model: "invalid-no-slash" });
  assert.equal(rBad.ok, false);
  assert.match(rBad.reason, /invalid vertex model/);
  assert.equal(fBad.calls.length, 0, "invalid model makes no network request");
});

test("vertex: missing key file, bad JSON, missing fields, or missing project -> clean failure, no request", async () => {
  resetVertexTokenCache();
  const f = fakeFetch([tokenResp(), chatResp({ content: "ok" })]);

  const missing = await run(f, { readFile: noFile });
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no key file/);

  const badJson = await run(f, { readFile: readKeyFromHome("{not-json") });
  assert.equal(badJson.ok, false);
  assert.match(badJson.reason, /invalid key file JSON/);

  const noEmail = await run(f, { readFile: readKeyFromHome(JSON.stringify({ private_key: PRIV_KEY })) });
  assert.equal(noEmail.ok, false);
  assert.match(noEmail.reason, /client_email or private_key/);

  const noProj = await run(f, { readFile: readKeyFromHome(JSON.stringify({ client_email: CLIENT_EMAIL, private_key: PRIV_KEY })) });
  assert.equal(noProj.ok, false);
  assert.match(noProj.reason, /no project/);

  assert.equal(f.calls.length, 0);
});

test("vertex: 403 mentioning billing / spend cap / BILLING_DISABLED -> reason starts with 'vertex: billing stopped'", async () => {
  for (const msg of [
    "Cloud Billing is disabled for project demo-proj",
    "Project has reached its spend cap",
    "Permission denied: BILLING_DISABLED on resource",
  ]) {
    resetVertexTokenCache();
    const f = fakeFetch([tokenResp(), statusResp(403, msg)]);
    const r = await run(f, { now: NOW_MS });
    assert.equal(r.ok, false);
    assert.ok(r.reason.startsWith("vertex: billing stopped"), `expected billing stopped prefix for: ${r.reason}`);
  }

  // Non-billing 403 stays a plain HTTP 403 failure.
  resetVertexTokenCache();
  const fPlain = fakeFetch([tokenResp(), statusResp(403, "IAM permission aiplatform.endpoints.predict denied")]);
  const rPlain = await run(fPlain, { now: NOW_MS });
  assert.equal(rPlain.ok, false);
  assert.match(rPlain.reason, /^HTTP 403:/);
  assert.ok(!rPlain.reason.startsWith("vertex: billing stopped"));
});

test("vertex: 429, 5xx, timeout, network error, 200 error, and empty content fail cleanly", async () => {
  resetVertexTokenCache();
  const r429 = await run(fakeFetch([tokenResp(), statusResp(429, "rate limited", { "retry-after": "15" })]), { now: NOW_MS });
  assert.equal(r429.ok, false);
  assert.match(r429.reason, /^HTTP 429: rate limited \| Retry-After: 15$/);

  const r500 = await run(fakeFetch([statusResp(503, "unavailable")]), { now: NOW_MS });
  assert.equal(r500.ok, false);
  assert.match(r500.reason, /^HTTP 503: unavailable/);

  const rNet = await run(async () => { throw new Error("socket hang up"); }, { now: NOW_MS });
  assert.match(rNet.reason, /unreachable: socket hang up/);

  const rSlow = await run(async () => { throw Object.assign(new Error("t"), { name: "TimeoutError" }); }, { now: NOW_MS });
  assert.match(rSlow.reason, /timed out after 300s/);

  const rErr = await run(fakeFetch([() => new Response(JSON.stringify({ error: { message: "bad model" } }), { status: 200 })]), { now: NOW_MS });
  assert.match(rErr.reason, /bad model/);

  const rEmpty = await run(fakeFetch([chatResp({ content: "   ", extra_content: { thought: "hidden" } })]), { now: NOW_MS });
  assert.equal(rEmpty.ok, false);
  assert.match(rEmpty.reason, /empty content/);
});

test("vertex: private key, JWT, and access token are stripped from every error reason and echoed answer", async () => {
  const keyBodyLine = PRIV_KEY.split(/\r?\n/).find((l) => l.length >= 20 && !l.startsWith("-----"));

  // Token exchange failure echoing private key material & JWT
  resetVertexTokenCache();
  const fTokErr = fakeFetch([
    async () => new Response(`rejected key ${PRIV_KEY} and ${keyBodyLine}`, { status: 400 }),
  ]);
  const rTokErr = await run(fTokErr, { now: NOW_MS });
  assert.equal(rTokErr.ok, false);
  assert.ok(!rTokErr.reason.includes(PRIV_KEY));
  assert.ok(!rTokErr.reason.includes(keyBodyLine));

  // Chat failure echoing access token and private key
  resetVertexTokenCache();
  const customTok = "secret-oauth-bearer-token-987654";
  const fChatErr = fakeFetch([
    tokenResp(customTok, 3600),
    statusResp(500, `upstream leaked ${customTok} and ${TOKEN} and ${keyBodyLine}`),
  ]);
  const rChatErr = await run(fChatErr, { now: NOW_MS });
  assert.equal(rChatErr.ok, false);
  assert.ok(!rChatErr.reason.includes(customTok));
  assert.ok(!rChatErr.reason.includes(TOKEN));
  assert.ok(!rChatErr.reason.includes(keyBodyLine));
  assert.match(rChatErr.reason, /\*\*\*/);

  // Network throw echoing token
  const rThrow = await run(async () => { throw new Error(`failed with ${customTok} and ${keyBodyLine}`); }, { now: NOW_MS });
  assert.ok(!rThrow.reason.includes(customTok));
  assert.ok(!rThrow.reason.includes(keyBodyLine));

  // Billing 403 echoing token
  const rBill = await run(fakeFetch([statusResp(403, `BILLING_DISABLED for token ${customTok}`)]), { now: NOW_MS });
  assert.ok(rBill.reason.startsWith("vertex: billing stopped"));
  assert.ok(!rBill.reason.includes(customTok));

  // Echoed answer body
  const rBody = await run(fakeFetch([chatResp({ content: `token=${customTok} key=${keyBodyLine}` })]), { now: NOW_MS });
  assert.equal(rBody.ok, true);
  assert.ok(!rBody.body.includes(customTok));
  assert.ok(!rBody.body.includes(keyBodyLine));
});

test("vertex: order parsing of two vertex entries, --vertex-model, panelModels, debate, and separate out files", async () => {
  assert.ok(MODEL_ENGINES.includes("vertex"));
  assert.equal(parseArgs(["--vertex-model", "zai-org/glm-5.2-maas", "hi"]).vertexModel, "zai-org/glm-5.2-maas");
  assert.equal(parseArgs(["hi"]).vertexModel, null);

  // Two distinct vertex entries both survive parsing
  assert.deepEqual(
    parseOrderDetailed("vertex:google/gemini-4-neon,vertex:zai-org/glm-5.2-maas").order,
    ["vertex", "vertex:zai-org/glm-5.2-maas"],
  );
  // With VERTEX_MODEL override, neither is dropped and both stay explicit
  assert.deepEqual(
    parseOrderDetailed("vertex:google/gemini-4-neon,vertex:zai-org/glm-5.2-maas", undefined, { vertexModel: "meta/other" }).order,
    ["vertex:google/gemini-4-neon", "vertex:zai-org/glm-5.2-maas"],
  );
  // Default order has both vertex entries and no agy; agy remains a valid engine
  const defOrder = parseOrderDetailed(undefined).order;
  assert.deepEqual(defOrder, [
    "copilot", "codex", "deepseek", "vertex", "nim", "openrouter", "opencode", "azure", "gemini", "vertex:zai-org/glm-5.2-maas",
  ]);
  assert.equal(defOrder.includes("agy"), false);
  assert.deepEqual(parseOrderDetailed("agy").order, ["agy"]);

  // panelModels includes vertex
  assert.equal(panelModels({}, {}).vertex, "google/gemini-4-neon");
  assert.equal(panelModels({ vertexModel: "zai-org/glm-5.2-maas" }, {}).vertex, "zai-org/glm-5.2-maas");

  // Debate stances accept two vertex models
  const debate = validateSpec({
    question: "q",
    stances: [
      { engine: "vertex:google/gemini-4-neon", stance: "pick A" },
      { engine: "vertex:zai-org/glm-5.2-maas", stance: "pick B" },
    ],
  });
  assert.deepEqual(debate.stances.map((s) => s.engine), ["vertex:google/gemini-4-neon", "vertex:zai-org/glm-5.2-maas"]);

  // Running two vertex entries through runPanel writes two separate out files and shares one OAuth token
  resetVertexTokenCache();
  let tokenCalls = 0;
  const f = async (url, init) => {
    if (String(url) === TOKEN_URL) {
      tokenCalls++;
      return tokenResp(TOKEN, 3600)();
    }
    const { model } = JSON.parse(init.body);
    return chatResp({ content: `ok from ${model}` })();
  };
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "cb-vertex-out-"));
  const order = parseOrderDetailed("vertex:google/gemini-4-neon,vertex:zai-org/glm-5.2-maas").order;
  const results = await runPanel({
    order,
    run: (spec) => runSpec(spec, { prompt: "say ok", env: {}, home: "/h", readFile: readKeyFromHome(), fetchImpl: f, now: NOW_MS }, {}),
    onSettle: (name, r) => writeEngineResult(outDir, name, r),
  });
  assert.equal(tokenCalls, 1, "parallel vertex entries share one in-flight OAuth token request");
  assert.deepEqual(results, [
    { engine: "vertex:google/gemini-4-neon", ok: true, body: "ok from google/gemini-4-neon" },
    { engine: "vertex:zai-org/glm-5.2-maas", ok: true, body: "ok from zai-org/glm-5.2-maas" },
  ]);
  const files = fs.readdirSync(outDir).sort();
  assert.deepEqual(files, ["vertex.md", "vertex_zai-org_glm-5.2-maas.md"]);
  assert.equal(fs.readFileSync(path.join(outDir, "vertex.md"), "utf8"), "## vertex:google/gemini-4-neon\n\nok from google/gemini-4-neon\n");
  assert.equal(fs.readFileSync(path.join(outDir, "vertex_zai-org_glm-5.2-maas.md"), "utf8"), "## vertex:zai-org/glm-5.2-maas\n\nok from zai-org/glm-5.2-maas\n");
});
