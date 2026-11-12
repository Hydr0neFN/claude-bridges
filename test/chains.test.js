import test from "node:test";
import assert from "node:assert/strict";
import { NIM_CHAIN, OPENROUTER_CHAIN, OPENCODE_PRIMARY, OPENCODE_RESERVE, OPENCODE_FAMILY, DEFAULT_NIM_MODEL, DEFAULT_OPENROUTER_MODEL } from "../lib/engines.js";

/** "nvidia/nemotron-3-ultra-550b-a55b:free" -> { vendor: "nvidia", stem: "nemotron" }. */
const family = (id) => {
  const [vendor, rest = ""] = id.replace(/:free$/, "").split("/");
  const stem = (rest.toLowerCase().match(/^[a-z]+/) ?? [rest])[0];
  return { vendor: vendor.toLowerCase(), stem };
};
const set = (chain, key) => new Set(chain.map((m) => family(m)[key]));

test("family(): vendor prefix and name stem", () => {
  assert.deepEqual(family("nvidia/nemotron-3-ultra-550b-a55b:free"), { vendor: "nvidia", stem: "nemotron" });
  assert.deepEqual(family("minimaxai/minimax-m3.1-flash"), { vendor: "minimaxai", stem: "minimax" });
  assert.deepEqual(family("z-ai/glm-5.3-flash"), { vendor: "z-ai", stem: "glm" });
});

test("default chains: five models each, led by their engine default", () => {
  assert.equal(NIM_CHAIN.length, 5);
  assert.equal(OPENROUTER_CHAIN.length, 5);
  assert.equal(NIM_CHAIN[0], DEFAULT_NIM_MODEL);
  assert.equal(OPENROUTER_CHAIN[0], "baidu/ernie-5.5-flash-preview:free");
  assert.equal(OPENROUTER_CHAIN[0], DEFAULT_OPENROUTER_MODEL);
});

test("default chains are family-disjoint: no vendor and no name stem appears in both", () => {
  for (const key of ["vendor", "stem"]) {
    const nim = set(NIM_CHAIN, key);
    const or = set(OPENROUTER_CHAIN, key);
    const shared = [...nim].filter((f) => or.has(f));
    assert.deepEqual(shared, [], `${key} shared by NIM_CHAIN and OPENROUTER_CHAIN`);
  }
});

test("opencode PRIMARY models are family-disjoint from nim and openrouter (vendor and stem)", () => {
  const oc = OPENCODE_PRIMARY.map((m) => OPENCODE_FAMILY[m]);
  assert.ok(oc.every(Boolean), "OPENCODE_FAMILY lacks a primary model");
  for (const key of ["vendor", "stem"]) {
    const ocSet = set(oc, key);
    for (const [name, chain] of [["NIM_CHAIN", NIM_CHAIN], ["OPENROUTER_CHAIN", OPENROUTER_CHAIN]]) {
      const shared = [...set(chain, key)].filter((f) => ocSet.has(f));
      assert.deepEqual(shared, [], `${key} shared by OPENCODE_PRIMARY and ${name}`);
    }
  }
  assert.ok(!oc.some((id) => /deepseek/.test(id)), "deepseek belongs to the deepseek engine");
});

test("opencode RESERVE models: each one overlaps exactly its declared owner chain, and only that one", () => {
  for (const [model, { owner, stem }] of Object.entries(OPENCODE_RESERVE)) {
    const id = OPENCODE_FAMILY[model];
    assert.ok(id, `${model} lacks a canonical id`);
    assert.equal(family(id).stem, stem);
    const chains = { nim: NIM_CHAIN, openrouter: OPENROUTER_CHAIN };
    for (const [name, chain] of Object.entries(chains)) {
      const overlaps = set(chain, "stem").has(stem) || set(chain, "vendor").has(family(id).vendor);
      assert.equal(overlaps, name === owner, `${model} vs ${name}`);
    }
  }
});
