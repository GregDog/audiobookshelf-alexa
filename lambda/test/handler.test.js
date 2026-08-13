'use strict';

// End-to-end tests for the Alexa skill handler. Invokes index.js's
// exported handler with synthesized request envelopes and asserts on the
// response shape (speech text + AudioPlayer directives + token contents).
// audiobookshelf calls are stubbed via test/fixtures/abs-mock.js — no
// network access required.

const test = require('node:test');
const assert = require('node:assert/strict');

const { installFetch, restoreFetch, FIXTURE } = require('./fixtures/abs-mock');
const {
  launch, intent, audioPlayerEvent, audioPlayerCtx, playbackController,
  invoke, speech, directives, playDirective, stopDirective,
} = require('./fixtures/alexa');
const { decodeToken, encodeToken } = require('../lib/playback');

// Wire the mock fetch BEFORE requiring index.js so the AbsClient picks
// it up at construction time.
installFetch();
const { handler } = require('../index');

test.beforeEach(() => { installFetch(); });
test.after(() => { restoreFetch(); });

// ---------------------------------------------------------------------------
// Launch + informational
// ---------------------------------------------------------------------------

test('LaunchRequest speaks welcome (de-DE)', async () => {
  const res = await invoke(handler, launch());
  assert.match(speech(res), /Willkommen bei Audiobookshelf/);
  assert.equal(res.response.shouldEndSession, false);
});

test('LaunchRequest speaks welcome (en-US)', async () => {
  const res = await invoke(handler, launch({ locale: 'en-US' }));
  assert.match(speech(res), /Our Library/);
});

test('ListLibrariesIntent reads library names', async () => {
  const res = await invoke(handler, intent('ListLibrariesIntent'));
  assert.match(speech(res), /Books/);
});

test('RecentBooksIntent reads recent titles', async () => {
  const res = await invoke(handler, intent('RecentBooksIntent'));
  assert.match(speech(res), /The Hobbit/);
  assert.match(speech(res), /Dune/);
});

test('ListInProgressIntent reads in-progress titles', async () => {
  const res = await invoke(handler, intent('ListInProgressIntent'));
  assert.match(speech(res), /The Hobbit/);
});

// ---------------------------------------------------------------------------
// PlayBookIntent
// ---------------------------------------------------------------------------

test('PlayBookIntent finds a book and resumes from saved progress', async () => {
  const res = await invoke(handler, intent('PlayBookIntent', { bookTitle: 'Hobbit' }));
  assert.match(speech(res), /Spiele The Hobbit/);
  const dir = playDirective(res);
  assert.ok(dir, 'expected AudioPlayer.Play directive');
  // 70s into the book = track 102 (idx 1, starts at 60), 10s in.
  assert.match(dir.audioItem.stream.url, /\/api\/items\/item-A\/file\/102/);
  assert.equal(dir.audioItem.stream.offsetInMilliseconds, 10_000);
  const tok = decodeToken(dir.audioItem.stream.token);
  assert.equal(tok.itemId, 'item-A');
  assert.equal(tok.trackIndex, 1);
  assert.equal(tok.trackStart, 60);
  assert.equal(tok.bookDuration, 180);
  assert.equal(tok.sleepDeadline, undefined);
});

test('PlayBookIntent without a slot prompts again', async () => {
  const res = await invoke(handler, intent('PlayBookIntent', {}));
  assert.match(speech(res), /Welches Hörbuch/);
  assert.equal(playDirective(res), undefined);
});

test('PlayBookIntent with no match speaks "not found"', async () => {
  const res = await invoke(handler, intent('PlayBookIntent', { bookTitle: 'completely unknown book' }));
  assert.match(speech(res), /habe kein Hörbuch/);
  assert.equal(playDirective(res), undefined);
});

// ---------------------------------------------------------------------------
// ContinueListeningIntent
// ---------------------------------------------------------------------------

test('ContinueListeningIntent without a slot picks the most recent in-progress book', async () => {
  const res = await invoke(handler, intent('ContinueListeningIntent'));
  assert.match(speech(res), /The Hobbit/);
  const tok = decodeToken(playDirective(res).audioItem.stream.token);
  assert.equal(tok.itemId, 'item-A');
});

test('ContinueListeningIntent with a title resumes that specific book', async () => {
  const res = await invoke(handler, intent('ContinueListeningIntent', { bookTitle: 'Dune' }));
  const dir = playDirective(res);
  assert.ok(dir);
  const tok = decodeToken(dir.audioItem.stream.token);
  assert.equal(tok.itemId, 'item-B');
  // Dune has no progress, so resumeAt = 0.
  assert.equal(tok.trackIndex, 0);
  assert.equal(dir.audioItem.stream.offsetInMilliseconds, 0);
});

// ---------------------------------------------------------------------------
// Chapter navigation
// ---------------------------------------------------------------------------

test('AMAZON.NextIntent jumps to next chapter', async () => {
  // Currently in chapter 2 (track idx 1, starts at 60) at offset 10s -> bookOffset 70.
  const ap = audioPlayerCtx({
    tokenState: { sessionId: 's', itemId: 'item-A', trackIndex: 1, trackCount: 3, trackStart: 60, bookDuration: 180 },
    offsetMs: 10_000,
  });
  const res = await invoke(handler, intent('AMAZON.NextIntent', {}, { audioPlayer: ap }));
  assert.match(speech(res), /Kapitel/);
  const dir = playDirective(res);
  assert.ok(dir);
  // Chapter 3 starts at 150s -> track idx 2 (starts at 150).
  const tok = decodeToken(dir.audioItem.stream.token);
  assert.equal(tok.trackIndex, 2);
  assert.equal(tok.trackStart, 150);
  assert.equal(dir.audioItem.stream.offsetInMilliseconds, 0);
});

test('AMAZON.PreviousIntent jumps to previous chapter', async () => {
  const ap = audioPlayerCtx({
    tokenState: { sessionId: 's', itemId: 'item-A', trackIndex: 1, trackCount: 3, trackStart: 60, bookDuration: 180 },
    offsetMs: 10_000,
  });
  const res = await invoke(handler, intent('AMAZON.PreviousIntent', {}, { audioPlayer: ap }));
  const tok = decodeToken(playDirective(res).audioItem.stream.token);
  assert.equal(tok.trackIndex, 0);
  assert.equal(tok.trackStart, 0);
});

test('AMAZON.NextIntent at last chapter speaks "already at last"', async () => {
  const ap = audioPlayerCtx({
    tokenState: { sessionId: 's', itemId: 'item-A', trackIndex: 2, trackCount: 3, trackStart: 150, bookDuration: 180 },
    offsetMs: 5_000,
  });
  const res = await invoke(handler, intent('AMAZON.NextIntent', {}, { audioPlayer: ap }));
  assert.match(speech(res), /letzten Kapitel/);
  assert.equal(playDirective(res), undefined);
});

test('AMAZON.NextIntent without active playback says "nothing playing"', async () => {
  const res = await invoke(handler, intent('AMAZON.NextIntent'));
  assert.match(speech(res), /läuft gerade nichts/);
});

test('PlaybackController.Next routes to chapter skip', async () => {
  const ap = audioPlayerCtx({
    tokenState: { sessionId: 's', itemId: 'item-A', trackIndex: 0, trackCount: 3, trackStart: 0, bookDuration: 180 },
    offsetMs: 0,
  });
  // The PlaybackController request has the AudioPlayer ctx but no separate body fields.
  const env = playbackController('Next', { token: ap.token, offsetInMilliseconds: 0 });
  const res = await invoke(handler, env);
  const tok = decodeToken(playDirective(res).audioItem.stream.token);
  assert.equal(tok.trackIndex, 1); // chapter 2
});

// ---------------------------------------------------------------------------
// Time-based seek
// ---------------------------------------------------------------------------

test('SeekBackwardIntent moves bookOffset back across track boundary', async () => {
  // Current: track idx 1 (starts 60), offset 20s -> bookOffset 80.
  // -30s -> 50s -> track idx 0 (0-60), offset 50s.
  const ap = audioPlayerCtx({
    tokenState: { sessionId: 's', itemId: 'item-A', trackIndex: 1, trackCount: 3, trackStart: 60, bookDuration: 180 },
    offsetMs: 20_000,
  });
  const res = await invoke(handler, intent('SeekBackwardIntent', { duration: '30', unit: 'Sekunden' }, { audioPlayer: ap }));
  const dir = playDirective(res);
  const tok = decodeToken(dir.audioItem.stream.token);
  assert.equal(tok.trackIndex, 0);
  assert.equal(tok.trackStart, 0);
  assert.equal(dir.audioItem.stream.offsetInMilliseconds, 50_000);
});

test('SeekForwardIntent +1 minute', async () => {
  const ap = audioPlayerCtx({
    tokenState: { sessionId: 's', itemId: 'item-A', trackIndex: 0, trackCount: 3, trackStart: 0, bookDuration: 180 },
    offsetMs: 30_000,
  });
  const res = await invoke(handler, intent('SeekForwardIntent', { duration: '1', unit: 'Minuten' }, { audioPlayer: ap }));
  const dir = playDirective(res);
  // 30 + 60 = 90s -> track idx 1 (starts 60), offset 30s.
  const tok = decodeToken(dir.audioItem.stream.token);
  assert.equal(tok.trackIndex, 1);
  assert.equal(dir.audioItem.stream.offsetInMilliseconds, 30_000);
});

// ---------------------------------------------------------------------------
// Sleep timer
// ---------------------------------------------------------------------------

test('SetSleepTimerIntent encodes sleepDeadline into the new token', async () => {
  const ap = audioPlayerCtx({
    tokenState: { sessionId: 's', itemId: 'item-A', trackIndex: 0, trackCount: 3, trackStart: 0, bookDuration: 180 },
    offsetMs: 5_000,
  });
  const before = Date.now();
  const res = await invoke(handler, intent('SetSleepTimerIntent', { duration: '30', unit: 'Minuten' }, { audioPlayer: ap }));
  const after = Date.now();
  const tok = decodeToken(playDirective(res).audioItem.stream.token);
  assert.ok(tok.sleepDeadline, 'expected sleepDeadline in token');
  assert.ok(tok.sleepDeadline >= before + 30 * 60 * 1000);
  assert.ok(tok.sleepDeadline <= after + 30 * 60 * 1000);
  assert.match(speech(res), /Sleep Timer auf 30 Minuten/);
});

test('CancelSleepTimerIntent removes the deadline from the token', async () => {
  const ap = audioPlayerCtx({
    tokenState: {
      sessionId: 's', itemId: 'item-A', trackIndex: 0, trackCount: 3, trackStart: 0, bookDuration: 180,
      sleepDeadline: Date.now() + 60_000,
    },
    offsetMs: 5_000,
  });
  const res = await invoke(handler, intent('CancelSleepTimerIntent', {}, { audioPlayer: ap }));
  const tok = decodeToken(playDirective(res).audioItem.stream.token);
  assert.equal(tok.sleepDeadline, undefined);
  assert.match(speech(res), /abgebrochen/);
});

test('CancelSleepTimerIntent without an active timer says "no sleep timer"', async () => {
  const ap = audioPlayerCtx({
    tokenState: { sessionId: 's', itemId: 'item-A', trackIndex: 0, trackCount: 3, trackStart: 0, bookDuration: 180 },
    offsetMs: 5_000,
  });
  const res = await invoke(handler, intent('CancelSleepTimerIntent', {}, { audioPlayer: ap }));
  assert.match(speech(res), /kein Sleep Timer/);
});

// ---------------------------------------------------------------------------
// AudioPlayer events (the part NO Alexa simulator exercises)
// ---------------------------------------------------------------------------

test('AudioPlayer.PlaybackNearlyFinished enqueues the next track', async () => {
  const tokenState = {
    sessionId: 's', itemId: 'item-A',
    trackIndex: 0, trackCount: 3, trackStart: 0, bookDuration: 180,
  };
  const env = audioPlayerEvent('PlaybackNearlyFinished', {
    token: encodeToken(tokenState),
    offsetInMilliseconds: 55_000,
  });
  const res = await invoke(handler, env);
  const dir = playDirective(res);
  assert.ok(dir, 'expected enqueue directive');
  assert.equal(dir.playBehavior, 'ENQUEUE');
  assert.match(dir.audioItem.stream.url, /\/api\/items\/item-A\/file\/102/);
  const tok = decodeToken(dir.audioItem.stream.token);
  assert.equal(tok.trackIndex, 1);
  assert.equal(tok.trackStart, 60);
  // syncSession was called with the current bookOffset.
  assert.equal(FIXTURE.syncCalls.length, 1);
  assert.equal(FIXTURE.syncCalls[0].currentTime, 55);
});

test('AudioPlayer.PlaybackNearlyFinished does NOT enqueue when sleep deadline passed', async () => {
  const tokenState = {
    sessionId: 's', itemId: 'item-A',
    trackIndex: 0, trackCount: 3, trackStart: 0, bookDuration: 180,
    sleepDeadline: Date.now() - 1000,
  };
  const env = audioPlayerEvent('PlaybackNearlyFinished', {
    token: encodeToken(tokenState),
    offsetInMilliseconds: 55_000,
  });
  const res = await invoke(handler, env);
  assert.equal(playDirective(res), undefined, 'expected no enqueue when deadline expired');
});

test('AudioPlayer.PlaybackNearlyFinished on the last track does not enqueue', async () => {
  const tokenState = {
    sessionId: 's', itemId: 'item-A',
    trackIndex: 2, trackCount: 3, trackStart: 150, bookDuration: 180,
  };
  const env = audioPlayerEvent('PlaybackNearlyFinished', {
    token: encodeToken(tokenState),
    offsetInMilliseconds: 25_000,
  });
  const res = await invoke(handler, env);
  assert.equal(playDirective(res), undefined);
});

test('AudioPlayer.PlaybackStopped syncs progress', async () => {
  const tokenState = {
    sessionId: 's', itemId: 'item-A',
    trackIndex: 1, trackCount: 3, trackStart: 60, bookDuration: 180,
  };
  const env = audioPlayerEvent('PlaybackStopped', {
    token: encodeToken(tokenState),
    offsetInMilliseconds: 25_000,
  });
  await invoke(handler, env);
  assert.equal(FIXTURE.syncCalls.length, 1);
  assert.equal(FIXTURE.syncCalls[0].currentTime, 85); // 60 + 25
});

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

test('AMAZON.PauseIntent stops playback', async () => {
  const res = await invoke(handler, intent('AMAZON.PauseIntent'));
  assert.ok(stopDirective(res));
});

test('AMAZON.StopIntent stops playback', async () => {
  const res = await invoke(handler, intent('AMAZON.StopIntent'));
  assert.ok(stopDirective(res));
});
