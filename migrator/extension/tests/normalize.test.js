import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTitle, normalizeArtist, detectVersionTag, decodeHtmlEntities, songKey } from "../src/engine/normalize.js";

test("strips bracketed qualifiers, feat. tails and punctuation", () => {
  assert.equal(normalizeTitle("Yellow (Remastered 2011) [Explicit]"), "yellow");
  assert.equal(normalizeTitle("Señorita feat. Camila Cabello"), "señorita");
  assert.equal(normalizeArtist("Shawn Mendes, Camila Cabello"), "shawn mendes camila cabello");
});

test("keeps non-Latin scripts intact, including combining marks", () => {
  // Devanagari vowel signs are combining marks; a literal port of Python's
  // [^\w\s] to JS would blank them out.
  assert.equal(normalizeTitle("तुम ही हो!"), "तुम ही हो");
  assert.equal(normalizeArtist("アリジット・シン"), "アリジット シン");
});

test("detectVersionTag", () => {
  assert.equal(detectVersionTag("Song (Live at Wembley)"), "live");
  assert.equal(detectVersionTag("Song - Sped Up"), "sped_up");
  assert.equal(detectVersionTag("Plain Song"), "");
});

test("decodeHtmlEntities handles the entities JioSaavn actually sends", () => {
  assert.equal(decodeHtmlEntities("Tu Hai &quot;Ki&quot; &amp; More"), 'Tu Hai "Ki" & More');
  assert.equal(decodeHtmlEntities("Rock &#39;n&#x27; Roll"), "Rock 'n' Roll");
  assert.equal(decodeHtmlEntities("&unknown; stays"), "&unknown; stays");
});

test("songKey is the normalized title|artist pair", () => {
  assert.equal(songKey("Hello (Remix)", "Adele"), "hello|adele");
});
