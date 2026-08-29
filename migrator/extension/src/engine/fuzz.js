// Port of the two rapidfuzz functions the matcher needs: fuzz.ratio and
// fuzz.token_set_ratio. Read from rapidfuzz's own pure-Python fallback
// (migrator/.venv's rapidfuzz/fuzz_py.py) rather than assumed from docs —
// rapidfuzz's optimized C++ path computes the same three-way max
// algebraically without building the combined strings; this port uses the
// straightforward (slower but equivalent) form: build the three strings,
// run ratio() on each pair, take the max.

/** Length of the longest common subsequence of a and b. */
function lcsLength(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0) return 0;
  let prev = new Array(m + 1).fill(0);
  let curr = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      if (ca === b.charCodeAt(j - 1)) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = prev[j] > curr[j - 1] ? prev[j] : curr[j - 1];
      }
    }
    [prev, curr] = [curr, prev];
  }
  return prev[m];
}

/**
 * Normalized Indel similarity, 0-100 — rapidfuzz's fuzz.ratio.
 * similarity = 2*LCS(a,b) / (len(a)+len(b)), scaled to a percentage.
 */
export function ratio(a, b) {
  const total = a.length + b.length;
  if (total === 0) return 100;
  return (2 * lcsLength(a, b) * 100) / total;
}

/** rapidfuzz's fuzz.token_set_ratio, 0-100. */
export function tokenSetRatio(s1, s2) {
  const tokensA = new Set(s1.split(/\s+/).filter(Boolean));
  const tokensB = new Set(s2.split(/\s+/).filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  const intersect = [...tokensA].filter((t) => tokensB.has(t));
  const diffAB = [...tokensA].filter((t) => !tokensB.has(t));
  const diffBA = [...tokensB].filter((t) => !tokensA.has(t));

  // one token set is a subset of the other
  if (intersect.length && (diffAB.length === 0 || diffBA.length === 0)) return 100;

  const sect = [...intersect].sort().join(" ");
  const abJoined = [...diffAB].sort().join(" ");
  const baJoined = [...diffBA].sort().join(" ");

  const combined1 = sect ? (abJoined ? `${sect} ${abJoined}` : sect) : abJoined;
  const combined2 = sect ? (baJoined ? `${sect} ${baJoined}` : sect) : baJoined;

  return Math.max(ratio(combined1, combined2), ratio(sect, combined1), ratio(sect, combined2));
}
