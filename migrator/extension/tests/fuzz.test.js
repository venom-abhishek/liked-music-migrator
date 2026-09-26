import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenSetRatio, ratio } from "../src/engine/fuzz.js";

// Expected values produced by the real rapidfuzz (Python) fuzz.token_set_ratio,
// which engine/matcher.py uses — the JS port must agree exactly.
const RAPIDFUZZ_CASES = [
  ["tum hi ho", "tum hi ho arijit", 100],
  ["kesariya", "kesariya from brahmastra", 100],
  ["arijit singh pritam", "pritam arijit singh", 100],
  ["shreya ghoshal", "sonu nigam", 33.3333],
  ["abc def", "abd xyz", 42.8571],
  ["the night we met", "night we met", 100],
  ["hello world foo", "world hello bar baz", 84.6154],
  ["a", "b", 0],
  ["मेरे रश्के क़मर", "मेरे रश्के कमर", 96.5517],
];

test("tokenSetRatio matches rapidfuzz", () => {
  for (const [a, b, expected] of RAPIDFUZZ_CASES) {
    assert.equal(Math.round(tokenSetRatio(a, b) * 1e4) / 1e4, expected, `${a} | ${b}`);
  }
});

test("tokenSetRatio: empty input scores 0, like rapidfuzz", () => {
  assert.equal(tokenSetRatio("", "abc"), 0);
  assert.equal(tokenSetRatio("abc", "   "), 0);
});

test("ratio is symmetric and 100 for identical strings", () => {
  assert.equal(ratio("abc", "abc"), 100);
  assert.equal(ratio("kitten", "sitting"), ratio("sitting", "kitten"));
});
