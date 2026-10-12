// Small pure helpers for the "My music" screen. Kept out of the UI code so
// they can be unit-tested. (duplicateExtras is adapted from the 2026-10
// ChatGPT review.)

/**
 * The extra copies of songs that appear more than once in a list, i.e.
 * every occurrence after the first of the same video. `tracks` should be
 * in playlist order, so the copy that was added first is the one kept.
 * Only exact same-video copies count: two different uploads of a song
 * might be a deliberate choice (a live take, a different mix), so they're
 * never selected automatically.
 */
export function duplicateExtras(tracks) {
  const seen = new Set();
  return tracks.filter((t) => {
    if (!t.videoId) return false;
    if (seen.has(t.videoId)) return true;
    seen.add(t.videoId);
    return false;
  });
}
