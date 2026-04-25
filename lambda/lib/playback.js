'use strict';

// Helpers for turning an audiobookshelf item + playback session into the
// shape Alexa's AudioPlayer needs, and for round-tripping playback state
// through the AudioPlayer token.

// Concatenates audioTracks[*].duration to find which track contains a given
// "book-relative" offset (in seconds), and returns { trackIndex, offsetInTrack }.
function locateTrack(audioTracks, bookOffsetSec) {
  let acc = 0;
  for (let i = 0; i < audioTracks.length; i += 1) {
    const t = audioTracks[i];
    const end = acc + (t.duration || 0);
    if (bookOffsetSec < end || i === audioTracks.length - 1) {
      return { trackIndex: i, offsetInTrack: Math.max(0, bookOffsetSec - acc) };
    }
    acc = end;
  }
  return { trackIndex: 0, offsetInTrack: 0 };
}

// Sum of durations of tracks before `trackIndex`. Used to convert a
// per-track AudioPlayer offset back into a book-relative time.
function bookOffsetForTrack(audioTracks, trackIndex) {
  let acc = 0;
  for (let i = 0; i < trackIndex && i < audioTracks.length; i += 1) {
    acc += audioTracks[i].duration || 0;
  }
  return acc;
}

// Find the chapter that contains the given book-relative offset.
// audiobookshelf chapter shape: { id, start, end, title }.
// Returns { index, chapter } or null when the chapter list is empty.
function findChapter(chapters, bookOffsetSec) {
  if (!Array.isArray(chapters) || !chapters.length) return null;
  for (let i = 0; i < chapters.length; i += 1) {
    const c = chapters[i];
    if (bookOffsetSec >= c.start && bookOffsetSec < c.end) {
      return { index: i, chapter: c };
    }
  }
  // Past the last chapter end -> snap to the last chapter.
  const last = chapters.length - 1;
  return { index: last, chapter: chapters[last] };
}

// Compact JSON token Alexa echoes back on every AudioPlayer event. Keep
// it small — Alexa enforces a token length limit (~1024 chars).
function encodeToken(state) {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

function decodeToken(token) {
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

// True when the token carries a sleep deadline that has already passed.
function sleepDeadlineExpired(state, nowMs = Date.now()) {
  return Boolean(state && state.sleepDeadline && nowMs >= state.sleepDeadline);
}

// Convert {duration, unit} from a SetSleepTimer / Seek intent into seconds.
// Accepts either the resolved Amazon TimeUnit slot value (Sekunden/Minuten/
// seconds/minutes) or the raw user utterance.
function unitToSeconds(unit) {
  if (!unit) return 60; // default: minutes
  const u = String(unit).toLowerCase();
  if (u.startsWith('sek') || u.startsWith('sec')) return 1;
  if (u.startsWith('min')) return 60;
  if (u.startsWith('std') || u.startsWith('hour') || u.startsWith('stunde')) return 3600;
  return 60;
}

module.exports = {
  locateTrack,
  bookOffsetForTrack,
  findChapter,
  encodeToken,
  decodeToken,
  sleepDeadlineExpired,
  unitToSeconds,
};
