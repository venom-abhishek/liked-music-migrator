// Port of schema.py's normalize_title/normalize_artist/detect_version_tag,
// plus HTML-entity decoding (§9: "97/792 JioSaavn rows needed this and it
// broke matching when missed").
//
// One deliberate departure from a literal port: Python's `\w` (with the
// implicit re.UNICODE flag on str patterns) matches letters from ANY
// script, not just ASCII. JS's `\w` is ASCII-only even with the `u` flag.
// A naive port of `[^\w\s]` would treat every Devanagari/Japanese/etc.
// character as "punctuation" and blank it out — silently destroying
// non-Latin titles and artists, which matters a lot for a JioSaavn source.
// This uses Unicode property escapes (\p{L}\p{N}\p{M}) instead so the
// stripped set matches Python's intent for any script.

const BRACKET_RE = /[[(][^\])]*[\])]/g;
const FEAT_RE = /\b(feat\.?|ft\.?|featuring)\b.*$/i;
const PUNCT_RE = /[^\p{L}\p{N}\p{M}_\s]/gu;
const WS_RE = /\s+/g;

function baseNormalize(s) {
  if (!s) return "";
  let out = s.normalize("NFKC").toLowerCase();
  out = out.replace(BRACKET_RE, " ");
  out = out.replace(FEAT_RE, "");
  out = out.replace(PUNCT_RE, " ");
  out = out.replace(WS_RE, " ").trim();
  return out;
}

export const normalizeTitle = baseNormalize;
export const normalizeArtist = baseNormalize;

const VERSION_TAG_PATTERNS = [
  ["remix", /\bremix(?:es)?\b/i],
  ["live", /\blive\b/i],
  ["acoustic", /\bacoustic\b/i],
  ["cover", /\bcover\b/i],
  ["sped_up", /\bsped[\s-]?up\b/i],
  ["instrumental", /\binstrumental\b/i],
  ["explicit", /\bexplicit\b/i],
  ["remaster", /\bremaster(?:ed)?\b/i],
];

export function detectVersionTag(title) {
  if (!title) return "";
  for (const [tag, pattern] of VERSION_TAG_PATTERNS) {
    if (pattern.test(title)) return tag;
  }
  return "";
}

let decodeEl = null;
/** html.unescape equivalent: decodes named/numeric HTML entities. */
export function decodeHtmlEntities(s) {
  if (!s) return s;
  if (!decodeEl) decodeEl = document.createElement("textarea");
  decodeEl.innerHTML = s;
  return decodeEl.value;
}

/** Song.key() port: normalized identity used for dedup/comparison. */
export function songKey(title, artists) {
  return `${normalizeTitle(title)}|${normalizeArtist(artists)}`;
}
