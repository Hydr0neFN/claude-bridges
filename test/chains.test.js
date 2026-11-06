import test from "node:test";
import assert from "node:assert/strict";
import { NIM_CHAIN, OPENROUTER_CHAIN, OPENCODE_CHAIN, OPENCODE_FAMILY, DEFAULT_NIM_MODEL, DEFAULT_OPENROUTER_MODEL } from "../lib/engines.js";

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
  assert.equal(OPENROUTER_CHAIN[0], "poolside/laguna-s-2.1:free");
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

test("opencode chain is family-disjoint from nim and openrouter (vendor and stem), and every model has a canonical id", () => {
  const oc = OPENCODE_CHAIN.map((m) => OPENCODE_FAMILY[m]);
  assert.ok(oc.every(Boolean), "OPENCODE_FAMILY lacks a chain model");
  for (const key of ["vendor", "stem"]) {
    const ocSet = set(oc, key);
    for (const [name, chain] of [["NIM_CHAIN", NIM_CHAIN], ["OPENROUTER_CHAIN", OPENROUTER_CHAIN]]) {
      const shared = [...set(chain, key)].filter((f) => ocSet.has(f));
      assert.deepEqual(shared, [], `${key} shared by OPENCODE_CHAIN and ${name}`);
    }
  }
  assert.ok(!oc.some((id) => /deepseek/.test(id)), "deepseek belongs to the deepseek engine");
});
