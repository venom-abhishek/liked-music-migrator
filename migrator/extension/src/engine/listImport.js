// "A list of songs": the import source that works for any music app. Reads
// whatever the user has —
//   1. a spreadsheet (CSV / TSV) with a header row, e.g. the files free
//      export tools such as TuneMyMusic, Soundiiz or Exportify produce
//      (a "playlist" column, if present, keeps their playlists apart);
//   2. one song per line: "Title - Artist" (or "Title by Artist");
//   3. text copied straight off a web page (e.g. Ctrl+A, Ctrl+C on an Amazon
//      Music playlist), where each song is a few lines ending in its length;
// — and turns it into the importer's Song shape. Pure: no network, no DOM.

import { detectVersionTag } from "./normalize.js";

const HEADER_NAMES = {
  title: ["title", "track", "track name", "track title", "song", "song name", "song title", "name"],
  artist: ["artist", "artists", "artist name", "artist name(s)", "artist names", "artist(s)", "performer", "track artist", "album artist"],
  album: ["album", "album name", "album title", "release"],
  duration: ["duration", "duration (ms)", "duration_ms", "length", "time", "track duration (ms)"],
  playlist: ["playlist", "playlist name", "playlist title", "list"],
};
const DURATION_RE = /^\d{1,2}:\d{2}(:\d{2})?$/;
const MAX_SONGS = 50000;
const LIKED_NAME_RE = /^(liked|liked songs|liked music|liked tracks|my likes|favou?rites|favou?rite songs|loved tracks)$/i;

function norm(h) {
  return h.trim().toLowerCase().replace(/\s+/g, " ").replace(/^﻿/, "");
}

/** RFC 4180-ish CSV parse (quotes, doubled quotes, newlines inside quotes). */
export function parseDelimited(text, delimiter) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

function parseDurationValue(v, isMs) {
  const s = String(v || "").trim();
  if (!s) return null;
  if (DURATION_RE.test(s)) return s.split(":").reduce((acc, p) => acc * 60 + parseInt(p, 10), 0);
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Math.round(isMs || n > 10000 ? n / 1000 : n);
  }
  return null;
}

function findColumns(header) {
  const cols = {};
  const names = header.map(norm);
  for (const [key, options] of Object.entries(HEADER_NAMES)) {
    const idx = names.findIndex((n) => options.includes(n));
    if (idx >= 0) cols[key] = idx;
  }
  return cols;
}

function song(title, artists, album, duration_sec, collectionName) {
  const t = (title || "").trim();
  return {
    source: "list",
    collection_type: "playlist",
    collection_name: collectionName,
    source_id: "",
    title: t,
    // "A; B" and "A/B" style separators from export tools become "A, B".
    artists: (artists || "").replace(/\s*[;|/]\s*/g, ", ").trim(),
    album: (album || "").trim(),
    duration_sec,
    version_tag: detectVersionTag(t),
  };
}

function tryTable(text, fallbackName) {
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delimiter = firstLine.includes("\t") ? "\t" : firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
  const rows = parseDelimited(text, delimiter);
  if (rows.length < 2) return null;
  const cols = findColumns(rows[0]);
  if (cols.title == null) return null;
  const isMs = cols.duration != null && /ms/.test(norm(rows[0][cols.duration]));
  const songs = rows
    .slice(1)
    .map((r) =>
      song(
        r[cols.title],
        cols.artist != null ? r[cols.artist] : "",
        cols.album != null ? r[cols.album] : "",
        cols.duration != null ? parseDurationValue(r[cols.duration], isMs) : null,
        (cols.playlist != null && (r[cols.playlist] || "").trim()) || fallbackName
      )
    )
    .filter((s) => s.title);
  return { format: "spreadsheet", songs };
}

// Lines that are page furniture, not song data, in copied web-page text.
const NOISE_RE = /^(\d{1,4}|e|explicit|play|more|add|added|liked|download|downloaded|\+|…|\.\.\.|•|hd|ultra hd|lyrics)$/i;

function tryCopiedPage(lines, fallbackName) {
  const durationLines = lines.filter((l) => DURATION_RE.test(l)).length;
  if (durationLines < 2 || durationLines < lines.length / 8) return null;
  const songs = [];
  let block = [];
  for (const line of lines) {
    if (DURATION_RE.test(line)) {
      const text = block.filter((l) => !NOISE_RE.test(l));
      // A song row is title, artist, (album) before its length. Anything
      // longer is page text before the first row; take the last lines.
      const parts = text.slice(-3);
      if (parts.length >= 2) songs.push(song(parts[0], parts[1], parts[2] || "", parseDurationValue(line), fallbackName));
      else if (parts.length === 1) songs.push(song(parts[0], "", "", parseDurationValue(line), fallbackName));
      block = [];
    } else block.push(line);
  }
  return songs.length ? { format: "copied page", songs } : null;
}

function tryLines(lines, fallbackName) {
  const songs = lines
    .filter((l) => !NOISE_RE.test(l))
    .map((l) => {
      const line = l.replace(/^\s*\d+[.)]\s+/, ""); // "1. Song - Artist"
      let m = /^(.*?)\s+[-–—]\s+(.*)$/.exec(line);
      if (m) return song(m[1], m[2], "", null, fallbackName);
      m = /^(.*?)\s+by\s+(.*)$/i.exec(line);
      if (m) return song(m[1], m[2], "", null, fallbackName);
      return song(line, "", "", null, fallbackName);
    })
    .filter((s) => s.title);
  return songs.length ? { format: "lines", songs } : null;
}

/**
 * Parses pasted or uploaded text. Returns { format, songs, collections }
 * where collections lists [{ name, count }] in first-seen order. Throws a
 * plain-language Error if nothing usable is found.
 */
export function parseSongList(text, fallbackName = "Imported list") {
  const clean = String(text || "").replace(/^﻿/, "");
  if (!clean.trim()) throw new Error("There's nothing in the list yet.");
  const lines = clean.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const result = tryTable(clean, fallbackName) || tryCopiedPage(lines, fallbackName) || tryLines(lines, fallbackName);
  if (!result || !result.songs.length) throw new Error("No songs could be found in that text.");
  if (result.songs.length > MAX_SONGS) throw new Error(`That's more than ${MAX_SONGS.toLocaleString()} songs, which is too many to bring in at once.`);
  const counts = new Map();
  for (const s of result.songs) counts.set(s.collection_name, (counts.get(s.collection_name) || 0) + 1);
  // A list called "Liked songs" (or similar) in an export file is the user's
  // likes: in "same as before" mode it goes to Liked songs, not a playlist.
  for (const s of result.songs) if (LIKED_NAME_RE.test(s.collection_name)) s.collection_type = "liked";
  return { ...result, collections: [...counts.entries()].map(([name, count]) => ({ name, count })) };
}
