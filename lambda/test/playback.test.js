'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  locateTrack,
  bookOffsetForTrack,
  findChapter,
  encodeToken,
  decodeToken,
  sleepDeadlineExpired,
  unitToSeconds,
} = require('../lib/playback');

test('locateTrack picks the track containing the offset', () => {
  const tracks = [{ duration: 100 }, { duration: 200 }, { duration: 50 }];
  assert.deepEqual(locateTrack(tracks, 0), { trackIndex: 0, offsetInTrack: 0 });
  assert.deepEqual(locateTrack(tracks, 99), { trackIndex: 0, offsetInTrack: 99 });
  assert.deepEqual(locateTrack(tracks, 100), { trackIndex: 1, offsetInTrack: 0 });
  assert.deepEqual(locateTrack(tracks, 250), { trackIndex: 1, offsetInTrack: 150 });
  assert.deepEqual(locateTrack(tracks, 9999), { trackIndex: 2, offsetInTrack: 9699 });
});

test('bookOffsetForTrack sums prior track durations', () => {
  const tracks = [{ duration: 100 }, { duration: 200 }, { duration: 50 }];
  assert.equal(bookOffsetForTrack(tracks, 0), 0);
  assert.equal(bookOffsetForTrack(tracks, 1), 100);
  assert.equal(bookOffsetForTrack(tracks, 2), 300);
});

test('encodeToken / decodeToken round-trip', () => {
  const state = { sessionId: 'abc', itemId: 'xyz', trackIndex: 2, trackStart: 1234 };
  const round = decodeToken(encodeToken(state));
  assert.deepEqual(round, state);
});

test('decodeToken handles bad input gracefully', () => {
  assert.equal(decodeToken(''), null);
  assert.equal(decodeToken(null), null);
  assert.equal(decodeToken('not-base64-json!!!'), null);
});

test('findChapter returns the chapter containing the offset', () => {
  const chapters = [
    { start: 0, end: 100, title: 'Eins' },
    { start: 100, end: 250, title: 'Zwei' },
    { start: 250, end: 300, title: 'Drei' },
  ];
  assert.deepEqual(findChapter(chapters, 0).chapter.title, 'Eins');
  assert.deepEqual(findChapter(chapters, 99).chapter.title, 'Eins');
  assert.deepEqual(findChapter(chapters, 100).chapter.title, 'Zwei');
  assert.deepEqual(findChapter(chapters, 200).chapter.title, 'Zwei');
  assert.deepEqual(findChapter(chapters, 250).chapter.title, 'Drei');
  // Past the last chapter end -> snap to last.
  assert.deepEqual(findChapter(chapters, 99999).chapter.title, 'Drei');
  assert.equal(findChapter([], 10), null);
  assert.equal(findChapter(null, 10), null);
});

test('sleepDeadlineExpired respects deadline and "now"', () => {
  const now = 1_700_000_000_000;
  assert.equal(sleepDeadlineExpired(null, now), false);
  assert.equal(sleepDeadlineExpired({}, now), false);
  assert.equal(sleepDeadlineExpired({ sleepDeadline: now + 1000 }, now), false);
  assert.equal(sleepDeadlineExpired({ sleepDeadline: now }, now), true);
  assert.equal(sleepDeadlineExpired({ sleepDeadline: now - 1 }, now), true);
});

test('unitToSeconds parses unit slot values across locales', () => {
  assert.equal(unitToSeconds('Sekunden'), 1);
  assert.equal(unitToSeconds('Sekunde'), 1);
  assert.equal(unitToSeconds('seconds'), 1);
  assert.equal(unitToSeconds('Minuten'), 60);
  assert.equal(unitToSeconds('Minute'), 60);
  assert.equal(unitToSeconds('minutes'), 60);
  assert.equal(unitToSeconds('Stunde'), 3600);
  assert.equal(unitToSeconds('hours'), 3600);
  assert.equal(unitToSeconds(undefined), 60);
  assert.equal(unitToSeconds('xyz'), 60);
});
