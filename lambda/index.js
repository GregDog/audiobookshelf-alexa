'use strict';

const Alexa = require('ask-sdk-core');
const { fromEnv } = require('./lib/absClient');
const {
  locateTrack,
  bookOffsetForTrack,
  findChapter,
  encodeToken,
  decodeToken,
  sleepDeadlineExpired,
  unitToSeconds,
} = require('./lib/playback');
const { t } = require('./lib/strings');

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function speakerOf(handlerInput) {
  const locale = Alexa.getLocale(handlerInput.requestEnvelope) || 'en-US';
  return t(locale);
}

function getClient(handlerInput) {
  try {
    return fromEnv(process.env);
  } catch (err) {
    console.error('Audiobookshelf client init failed:', err.message);
    const speak = speakerOf(handlerInput);
    handlerInput.__speech = speak('notConfigured');
    return null;
  }
}

// AudioPlayer directives require an open session — without this Alexa can
// drop playback or behave erratically after PlayBookIntent.
function audioPlayResponse(h, builderFn) {
  return builderFn(h.responseBuilder).withShouldEndSession(false).getResponse();
}

async function resolveLibraryId(client) {
  if (process.env.ABS_DEFAULT_LIBRARY_ID) return process.env.ABS_DEFAULT_LIBRARY_ID;
  const { libraries = [] } = await client.listLibraries();
  const book = libraries.find((l) => l.mediaType === 'book') || libraries[0];
  if (!book) throw new Error('no libraries configured on audiobookshelf');
  return book.id;
}

// Generate progressively-broader search queries from a user utterance.
// audiobookshelf's /search is a tokenized fuzzy match: leading articles
// ("die asyl-lotterie") and hyphens hurt scoring because each token has
// to find a hit. So we try the raw query first, then a stripped variant,
// then the longest single keyword as a last resort.
function searchVariants(query) {
  const variants = [];
  const push = (q) => {
    const t = (q || '').trim();
    if (t && !variants.includes(t)) variants.push(t);
  };
  push(query);

  // Replace hyphens with spaces ("asyl-lotterie" -> "asyl lotterie") and
  // collapse repeated whitespace.
  const dehyphenated = query.replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
  push(dehyphenated);

  // Strip common leading articles (de + en) and try again.
  const stripped = dehyphenated.replace(
    /^(die|der|das|den|dem|des|ein|eine|einen|einem|einer|the|a|an)\s+/i,
    '',
  ).trim();
  push(stripped);

  // Last resort: longest single word (≥4 chars), which is what carried
  // the user's intent ("Lotterie" in "die Asyl-Lotterie").
  const longest = stripped.split(/\s+/)
    .filter((w) => w.length >= 4)
    .sort((a, b) => b.length - a.length)[0];
  if (longest) push(longest);

  return variants;
}

// Normalize a string for fuzzy matching: lowercase, replace umlauts/ß,
// strip everything except a-z0-9. Both the query and the title go through
// the same pipeline so "Asyl-Lotterie" and "asyllotterie" collapse to the
// same canonical form.
function normalizeForMatch(s) {
  return (s || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
}

// Score a candidate title against a normalized query using overlapping
// 3-grams. Score = matched / total, in [0,1]. Substring containment also
// gets a bonus, which catches Alexa's habit of mashing words together
// ("asyllotterie" contained in "dieasyllotterie").
function fuzzyScore(qNorm, titleNorm) {
  if (!qNorm || !titleNorm) return 0;
  if (titleNorm.includes(qNorm) || qNorm.includes(titleNorm)) return 1;
  if (qNorm.length < 3) return 0;
  let hits = 0;
  for (let i = 0; i <= qNorm.length - 3; i += 1) {
    if (titleNorm.includes(qNorm.slice(i, i + 3))) hits += 1;
  }
  return hits / (qNorm.length - 2);
}

// Last-resort: pull the entire library and pick the best fuzzy match
// locally. Slower than the server search (we may pull a few hundred
// items) but bullet-proof against Alexa's tokenization quirks.
async function localFuzzyFindBook(client, libraryId, query) {
  const qNorm = normalizeForMatch(query);
  if (!qNorm || qNorm.length < 3) return null;

  // For typical personal libraries (< ~1000 titles), one big page is fine.
  const page = await client.listItems(libraryId, { limit: 300, page: 0 });
  const items = (page.results || page.items || page || []);

  let best = null;
  let bestScore = 0;
  for (const it of items) {
    const meta = (it.media && it.media.metadata) || it.metadata || {};
    const candidates = [meta.title, meta.subtitle, meta.titleIgnorePrefix]
      .filter(Boolean)
      .map(normalizeForMatch);
    let score = 0;
    for (const c of candidates) {
      score = Math.max(score, fuzzyScore(qNorm, c));
    }
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }

  // Require a reasonable threshold so we don't return random hits when
  // the user mentioned a book that isn't in the library at all.
  return bestScore >= 0.5 ? best : null;
}

async function findBook(client, libraryId, query) {
  for (const q of searchVariants(query)) {
    try {
      const results = await client.search(libraryId, q, { limit: 5 });
      const hits = (results.book || results.items || []).map((h) => h.libraryItem || h);
      if (hits.length) return hits[0];
    } catch (err) {
      console.warn('search failed:', q, err.message || err);
    }
  }
  return localFuzzyFindBook(client, libraryId, query);
}

async function itemWithProgress(client, item) {
  const progress = item.userMediaProgress
    || (item.media && item.media.userMediaProgress);
  if (progress) return item;
  return client.getItem(item.id);
}

// Decoded AudioPlayer state from the inbound request (token + offset). Null
// when no playback context is attached.
function currentPlaybackState(handlerInput) {
  const ap = handlerInput.requestEnvelope.context && handlerInput.requestEnvelope.context.AudioPlayer;
  if (!ap || !ap.token) return null;
  const state = decodeToken(ap.token);
  if (!state) return null;
  const offsetSec = (ap.offsetInMilliseconds || 0) / 1000;
  return {
    ...state,
    offsetInTrackSec: offsetSec,
    bookOffset: (state.trackStart || 0) + offsetSec,
  };
}

// Build an AudioPlayer Play directive that streams an audiobookshelf item
// from a given book-relative offset. Optional sleepDeadline is encoded in
// the AudioPlayer token so it survives across PlaybackNearlyFinished events.
async function buildPlayDirective(client, item, opts = {}) {
  const { bookOffsetSec = 0, sleepDeadline = null } = opts;
  const session = await client.startPlaybackSession(item.id);
  const tracks = session.audioTracks || [];
  if (!tracks.length) throw new Error(`item ${item.id} has no audio tracks`);

  const bookDuration = tracks.reduce((s, x) => s + (x.duration || 0), 0);
  const clampedOffset = Math.max(0, Math.min(bookOffsetSec, bookDuration - 1));
  const { trackIndex, offsetInTrack } = locateTrack(tracks, clampedOffset);
  const track = tracks[trackIndex];
  const url = client.streamUrlFor(track.contentUrl, track.mimeType);

  const tokenState = {
    sessionId: session.id,
    itemId: item.id,
    trackIndex,
    trackCount: tracks.length,
    trackStart: bookOffsetForTrack(tracks, trackIndex),
    bookDuration,
  };
  if (sleepDeadline) tokenState.sleepDeadline = sleepDeadline;

  const meta = (item.media && item.media.metadata) || {};
  const title = meta.title || 'Audiobook';
  const author = meta.authorName
    || (Array.isArray(meta.authors) && meta.authors.map((a) => a.name).join(', '))
    || '';

  const directive = {
    type: 'AudioPlayer.Play',
    playBehavior: 'REPLACE_ALL',
    audioItem: {
      stream: {
        token: encodeToken(tokenState),
        url,
        offsetInMilliseconds: Math.round(offsetInTrack * 1000),
      },
      metadata: { title, subtitle: author },
    },
  };
  return { directive, title, author, session, tracks, bookDuration };
}

// Build a directive that enqueues the *next* track of the same book after
// the current one. Called from PlaybackNearlyFinished. Returns null when
// there is no next track (book finished) or the sleep timer has fired.
async function buildEnqueueNextDirective(client, prevState) {
  if (sleepDeadlineExpired(prevState)) return null;
  const { itemId, trackIndex, trackCount } = prevState;
  if (trackIndex == null || trackIndex >= (trackCount || 0) - 1) return null;

  const session = await client.startPlaybackSession(itemId);
  const tracks = session.audioTracks || [];
  const nextIndex = trackIndex + 1;
  if (!tracks[nextIndex]) return null;

  const url = client.streamUrlFor(tracks[nextIndex].contentUrl, tracks[nextIndex].mimeType);
  const newTokenState = {
    ...prevState,
    sessionId: session.id,
    trackIndex: nextIndex,
    trackCount: tracks.length,
    trackStart: bookOffsetForTrack(tracks, nextIndex),
  };

  return {
    type: 'AudioPlayer.Play',
    playBehavior: 'ENQUEUE',
    audioItem: {
      stream: {
        token: encodeToken(newTokenState),
        expectedPreviousToken: encodeToken(prevState),
        url,
        offsetInMilliseconds: 0,
      },
    },
  };
}

// Re-launch playback at a new book-relative offset, preserving the existing
// sleepDeadline (if any). Used by chapter navigation, seek, and sleep timer.
async function relaunchAtOffset(client, current, newBookOffset, { sleepDeadline } = {}) {
  const item = await client.getItem(current.itemId);
  return buildPlayDirective(client, item, {
    bookOffsetSec: newBookOffset,
    sleepDeadline: sleepDeadline !== undefined ? sleepDeadline : current.sleepDeadline || null,
  });
}

// Localized labels for spoken units.
function unitLabel(locale, unitSlotValue, n) {
  const isDe = locale && locale.startsWith('de');
  const u = String(unitSlotValue || '').toLowerCase();
  if (u.startsWith('sek') || u.startsWith('sec')) return isDe ? (n === 1 ? 'Sekunde' : 'Sekunden') : (n === 1 ? 'second' : 'seconds');
  return isDe ? (n === 1 ? 'Minute' : 'Minuten') : (n === 1 ? 'minute' : 'minutes');
}

// ---------------------------------------------------------------------------
// Intent handlers — launch / informational
// ---------------------------------------------------------------------------

const LaunchRequestHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'LaunchRequest'; },
  handle(h) {
    const speak = speakerOf(h);
    return h.responseBuilder.speak(speak('welcome')).reprompt(speak('noQuery')).getResponse();
  },
};

const HelpIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(h) {
    const speak = speakerOf(h);
    return h.responseBuilder.speak(speak('help')).reprompt(speak('help')).getResponse();
  },
};

const ListLibrariesIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'ListLibrariesIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const client = getClient(h);
    if (!client) return h.responseBuilder.speak(h.__speech).getResponse();
    try {
      const { libraries = [] } = await client.listLibraries();
      if (!libraries.length) return h.responseBuilder.speak(speak('noLibraries')).getResponse();
      return h.responseBuilder.speak(speak('libraries', libraries.map((l) => l.name))).getResponse();
    } catch (err) {
      console.error('ListLibrariesIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

const RecentBooksIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'RecentBooksIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const client = getClient(h);
    if (!client) return h.responseBuilder.speak(h.__speech).getResponse();
    try {
      const libraryId = await resolveLibraryId(client);
      const list = await client.listItems(libraryId, { limit: 5, sort: 'addedAt', desc: 1 });
      const titles = (list.results || list.items || [])
        .map((it) => it.media && it.media.metadata && it.media.metadata.title)
        .filter(Boolean);
      return h.responseBuilder.speak(speak('recentBooks', titles)).getResponse();
    } catch (err) {
      console.error('RecentBooksIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

const ListInProgressIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'ListInProgressIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const client = getClient(h);
    if (!client) return h.responseBuilder.speak(h.__speech).getResponse();
    try {
      const me = await client.getMe();
      const inProg = (me.mediaProgress || [])
        .filter((p) => !p.isFinished && p.currentTime > 0)
        .sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0))
        .slice(0, 5);
      // Hydrate titles in parallel.
      const titles = await Promise.all(inProg.map(async (p) => {
        try {
          const it = await client.getItem(p.libraryItemId);
          return it.media && it.media.metadata && it.media.metadata.title;
        } catch (_) { return null; }
      }));
      return h.responseBuilder.speak(speak('inProgress', titles.filter(Boolean))).getResponse();
    } catch (err) {
      console.error('ListInProgressIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

// ---------------------------------------------------------------------------
// Intent handlers — playback start / resume
// ---------------------------------------------------------------------------

const PlayBookIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'PlayBookIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const client = getClient(h);
    if (!client) return h.responseBuilder.speak(h.__speech).getResponse();

    const query = Alexa.getSlotValue(h.requestEnvelope, 'bookTitle');
    if (!query) {
      return h.responseBuilder.speak(speak('noQuery')).reprompt(speak('noQuery')).getResponse();
    }
    try {
      const libraryId = await resolveLibraryId(client);
      const item = await findBook(client, libraryId, query);
      if (!item) return h.responseBuilder.speak(speak('bookNotFound', query)).getResponse();

      const fullItem = await itemWithProgress(client, item);
      const progress = fullItem.userMediaProgress
        || (fullItem.media && fullItem.media.userMediaProgress);
      const resumeAt = progress && !progress.isFinished ? (progress.currentTime || 0) : 0;

      const { directive, title, author } = await buildPlayDirective(client, fullItem, { bookOffsetSec: resumeAt });
      console.log('PlayBookIntent playing', { title, trackUrl: directive.audioItem.stream.url.split('?')[0] });
      return audioPlayResponse(h, (rb) => rb.speak(speak('playing', title, author)).addDirective(directive));
    } catch (err) {
      console.error('PlayBookIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

const ContinueListeningIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    const name = Alexa.getIntentName(h.requestEnvelope);
    return name === 'ContinueListeningIntent' || name === 'AMAZON.ResumeIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);

    // If something is already playing and the user just said "resume", just
    // continue current playback rather than restarting from progress.
    const ap = h.requestEnvelope.context && h.requestEnvelope.context.AudioPlayer;
    const intentName = Alexa.getIntentName(h.requestEnvelope);
    if (intentName === 'AMAZON.ResumeIntent' && ap && ap.playerActivity === 'PAUSED' && ap.token) {
      const state = decodeToken(ap.token);
      if (state) {
        // The simplest "resume" is to re-play the current track at its offset.
        const client = getClient(h);
        if (!client) return h.responseBuilder.speak(h.__speech).getResponse();
        try {
          const { directive } = await relaunchAtOffset(client, {
            ...state, bookOffset: (state.trackStart || 0) + (ap.offsetInMilliseconds || 0) / 1000,
          }, (state.trackStart || 0) + (ap.offsetInMilliseconds || 0) / 1000);
          return audioPlayResponse(h, (rb) => rb.addDirective(directive));
        } catch (err) {
          console.error('Resume current playback failed:', err);
        }
      }
    }

    const client = getClient(h);
    if (!client) return h.responseBuilder.speak(h.__speech).getResponse();

    const query = Alexa.getSlotValue(h.requestEnvelope, 'bookTitle');
    try {
      let item;
      if (query) {
        const libraryId = await resolveLibraryId(client);
        const found = await findBook(client, libraryId, query);
        if (!found) return h.responseBuilder.speak(speak('bookNotFound', query)).getResponse();
        item = await client.getItem(found.id);
      } else {
        const me = await client.getMe();
        const inProgress = (me.mediaProgress || [])
          .filter((p) => !p.isFinished && p.currentTime > 0)
          .sort((a, b) => (b.lastUpdate || 0) - (a.lastUpdate || 0));
        if (!inProgress.length) {
          return h.responseBuilder.speak(speak('nothingToResume')).getResponse();
        }
        item = await client.getItem(inProgress[0].libraryItemId);
      }

      const progress = item.userMediaProgress
        || (item.media && item.media.userMediaProgress);
      const resumeAt = progress && !progress.isFinished ? (progress.currentTime || 0) : 0;
      const { directive, title, author } = await buildPlayDirective(client, item, { bookOffsetSec: resumeAt });
      return audioPlayResponse(h, (rb) => rb.speak(speak('resuming', title, author)).addDirective(directive));
    } catch (err) {
      console.error('ContinueListeningIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

// ---------------------------------------------------------------------------
// Intent handlers — chapter / seek navigation
// ---------------------------------------------------------------------------

const NextChapterIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    const n = Alexa.getIntentName(h.requestEnvelope);
    return n === 'AMAZON.NextIntent' || n === 'NextChapterIntent';
  },
  async handle(h) {
    return moveByChapter(h, +1);
  },
};

const PreviousChapterIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    const n = Alexa.getIntentName(h.requestEnvelope);
    return n === 'AMAZON.PreviousIntent' || n === 'PreviousChapterIntent';
  },
  async handle(h) {
    return moveByChapter(h, -1);
  },
};

async function moveByChapter(h, direction) {
  const speak = speakerOf(h);
  const current = currentPlaybackState(h);
  if (!current) return h.responseBuilder.speak(speak('notPlaying')).getResponse();
  const client = getClient(h);
  if (!client) return h.responseBuilder.speak(h.__speech).getResponse();
  try {
    const item = await client.getItem(current.itemId);
    const chapters = (item.media && item.media.chapters) || [];
    if (!chapters.length) return h.responseBuilder.speak(speak('noChapters')).getResponse();

    const found = findChapter(chapters, current.bookOffset);
    const idx = found ? found.index : 0;
    const targetIdx = idx + direction;
    if (targetIdx < 0) return h.responseBuilder.speak(speak('alreadyAtFirstChapter')).getResponse();
    if (targetIdx >= chapters.length) return h.responseBuilder.speak(speak('alreadyAtLastChapter')).getResponse();

    const target = chapters[targetIdx];
    const { directive } = await buildPlayDirective(client, item, {
      bookOffsetSec: target.start,
      sleepDeadline: current.sleepDeadline || null,
    });
    return audioPlayResponse(h, (rb) => rb
      .speak(speak('movedToChapter', target.title || `${targetIdx + 1}`))
      .addDirective(directive));
  } catch (err) {
    console.error('moveByChapter error:', err);
    return h.responseBuilder.speak(speak('serverError')).getResponse();
  }
}

const SeekForwardIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'SeekForwardIntent';
  },
  async handle(h) { return seekBy(h, +1); },
};

const SeekBackwardIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'SeekBackwardIntent';
  },
  async handle(h) { return seekBy(h, -1); },
};

async function seekBy(h, sign) {
  const speak = speakerOf(h);
  const locale = Alexa.getLocale(h.requestEnvelope);
  const current = currentPlaybackState(h);
  if (!current) return h.responseBuilder.speak(speak('notPlaying')).getResponse();
  const client = getClient(h);
  if (!client) return h.responseBuilder.speak(h.__speech).getResponse();

  const nRaw = Alexa.getSlotValue(h.requestEnvelope, 'duration');
  const unit = Alexa.getSlotValue(h.requestEnvelope, 'unit');
  const n = parseInt(nRaw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    return h.responseBuilder.speak(speak('help')).getResponse();
  }
  const deltaSec = n * unitToSeconds(unit);
  const newOffset = Math.max(0, current.bookOffset + sign * deltaSec);

  try {
    const { directive } = await relaunchAtOffset(client, current, newOffset);
    const key = sign > 0 ? 'seekedForward' : 'seekedBackward';
    return audioPlayResponse(h, (rb) => rb
      .speak(speak(key, n, unitLabel(locale, unit, n)))
      .addDirective(directive));
  } catch (err) {
    console.error('seekBy error:', err);
    return h.responseBuilder.speak(speak('serverError')).getResponse();
  }
}

// ---------------------------------------------------------------------------
// Intent handlers — sleep timer
// ---------------------------------------------------------------------------

const SetSleepTimerIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'SetSleepTimerIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const locale = Alexa.getLocale(h.requestEnvelope);
    const current = currentPlaybackState(h);
    if (!current) return h.responseBuilder.speak(speak('notPlaying')).getResponse();
    const client = getClient(h);
    if (!client) return h.responseBuilder.speak(h.__speech).getResponse();

    const nRaw = Alexa.getSlotValue(h.requestEnvelope, 'duration');
    const unit = Alexa.getSlotValue(h.requestEnvelope, 'unit');
    const n = parseInt(nRaw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      return h.responseBuilder.speak(speak('help')).getResponse();
    }
    const deadline = Date.now() + n * unitToSeconds(unit) * 1000;

    try {
      const { directive } = await relaunchAtOffset(client, current, current.bookOffset, { sleepDeadline: deadline });
      return audioPlayResponse(h, (rb) => rb
        .speak(speak('sleepTimerSet', n, unitLabel(locale, unit, n)))
        .addDirective(directive));
    } catch (err) {
      console.error('SetSleepTimerIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

const CancelSleepTimerIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'CancelSleepTimerIntent';
  },
  async handle(h) {
    const speak = speakerOf(h);
    const current = currentPlaybackState(h);
    if (!current) return h.responseBuilder.speak(speak('noSleepTimer')).getResponse();
    if (!current.sleepDeadline) return h.responseBuilder.speak(speak('noSleepTimer')).getResponse();
    const client = getClient(h);
    if (!client) return h.responseBuilder.speak(h.__speech).getResponse();
    try {
      const { directive } = await relaunchAtOffset(client, current, current.bookOffset, { sleepDeadline: null });
      return audioPlayResponse(h, (rb) => rb.speak(speak('sleepTimerCancelled')).addDirective(directive));
    } catch (err) {
      console.error('CancelSleepTimerIntent error:', err);
      return h.responseBuilder.speak(speak('serverError')).getResponse();
    }
  },
};

// ---------------------------------------------------------------------------
// Transport (Pause/Stop) and PlaybackController (hardware buttons)
// ---------------------------------------------------------------------------

const PauseIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    const n = Alexa.getIntentName(h.requestEnvelope);
    return n === 'AMAZON.PauseIntent' || n === 'AMAZON.StopIntent' || n === 'AMAZON.CancelIntent';
  },
  handle(h) {
    return audioPlayResponse(h, (rb) => rb.addDirective({ type: 'AudioPlayer.Stop' }));
  },
};

const PlaybackControllerHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope).startsWith('PlaybackController.');
  },
  async handle(h) {
    const type = h.requestEnvelope.request.type;
    if (type === 'PlaybackController.PauseCommandIssued') {
      return audioPlayResponse(h, (rb) => rb.addDirective({ type: 'AudioPlayer.Stop' }));
    }
    if (type === 'PlaybackController.PlayCommandIssued') {
      const current = currentPlaybackState(h);
      if (!current) return h.responseBuilder.getResponse();
      const client = getClient(h);
      if (!client) return h.responseBuilder.getResponse();
      const { directive } = await relaunchAtOffset(client, current, current.bookOffset);
      return audioPlayResponse(h, (rb) => rb.addDirective(directive));
    }
    if (type === 'PlaybackController.NextCommandIssued') return moveByChapter(h, +1);
    if (type === 'PlaybackController.PreviousCommandIssued') return moveByChapter(h, -1);
    return h.responseBuilder.getResponse();
  },
};

// ---------------------------------------------------------------------------
// AudioPlayer events: progress sync + auto-enqueue + sleep timer enforcement
// ---------------------------------------------------------------------------

const AudioPlayerEventHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope).startsWith('AudioPlayer.');
  },
  async handle(h) {
    const req = h.requestEnvelope.request;
    const type = req.type;
    console.log('AudioPlayer event:', type, JSON.stringify({ error: req.error, offsetInMilliseconds: req.offsetInMilliseconds }));
    const state = decodeToken(req.token);
    if (!state) return h.responseBuilder.getResponse();

    let client = null;
    try { client = fromEnv(process.env); } catch (_) { /* noop */ }

    const offsetSec = (req.offsetInMilliseconds || 0) / 1000;
    const bookOffset = (state.trackStart || 0) + offsetSec;

    try {
      if (client && state.sessionId
        && (type === 'AudioPlayer.PlaybackStopped'
          || type === 'AudioPlayer.PlaybackFinished'
          || type === 'AudioPlayer.PlaybackNearlyFinished')) {
        await client.syncSession(state.sessionId, {
          currentTime: bookOffset,
          timeListened: 5,
          duration: state.bookDuration || 0,
        }).catch((e) => console.warn('session sync failed:', e.message));
      }

      if (type === 'AudioPlayer.PlaybackNearlyFinished' && client) {
        if (sleepDeadlineExpired(state)) {
          // Don't enqueue — playback ends naturally at the end of the
          // current track, which acts as our sleep timer cut-off.
          return h.responseBuilder.getResponse();
        }
        const next = await buildEnqueueNextDirective(client, state).catch((e) => {
          console.warn('enqueue next failed:', e.message);
          return null;
        });
        if (next) return audioPlayResponse(h, (rb) => rb.addDirective(next));
      }
    } catch (err) {
      console.error('AudioPlayer handler error:', err);
    }

    return h.responseBuilder.getResponse();
  },
};

const SessionEndedRequestHandler = {
  canHandle(h) { return Alexa.getRequestType(h.requestEnvelope) === 'SessionEndedRequest'; },
  handle(h) { return h.responseBuilder.getResponse(); },
};

const FallbackIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(h.requestEnvelope) === 'AMAZON.FallbackIntent';
  },
  handle(h) {
    const speak = speakerOf(h);
    return h.responseBuilder.speak(speak('didntUnderstand')).reprompt(speak('noQuery')).getResponse();
  },
};

const AmazonBuiltInIntentHandler = {
  canHandle(h) {
    if (Alexa.getRequestType(h.requestEnvelope) !== 'IntentRequest') return false;
    const n = Alexa.getIntentName(h.requestEnvelope);
    return n === 'AMAZON.StartOverIntent'
      || n === 'AMAZON.LoopOnIntent'
      || n === 'AMAZON.LoopOffIntent'
      || n === 'AMAZON.ShuffleOnIntent'
      || n === 'AMAZON.ShuffleOffIntent';
  },
  handle(h) {
    const speak = speakerOf(h);
    return h.responseBuilder.speak(speak('notPlaying')).getResponse();
  },
};

const UnhandledIntentHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'IntentRequest';
  },
  handle(h) {
    const intent = Alexa.getIntentName(h.requestEnvelope);
    console.warn('Unhandled intent:', intent);
    const speak = speakerOf(h);
    return h.responseBuilder.speak(speak('didntUnderstand')).reprompt(speak('noQuery')).getResponse();
  },
};

const SystemExceptionHandler = {
  canHandle(h) {
    return Alexa.getRequestType(h.requestEnvelope) === 'System.ExceptionEncountered';
  },
  handle(h) {
    console.error('System.ExceptionEncountered:', JSON.stringify(h.requestEnvelope.request));
    return h.responseBuilder.getResponse();
  },
};

const LogRequestInterceptor = {
  process(input) {
    const req = input.requestEnvelope.request;
    const intent = req.type === 'IntentRequest' ? req.intent && req.intent.name : undefined;
    console.log('Request:', req.type, intent || '');
  },
};

const ErrorHandler = {
  canHandle() { return true; },
  handle(h, err) {
    const reqType = Alexa.getRequestType(h.requestEnvelope);
    const intent = reqType === 'IntentRequest' ? Alexa.getIntentName(h.requestEnvelope) : '';
    const msg = err && (err.message || String(err));
    const unhandled = msg && msg.includes('Unable to find a suitable request handler');
    console.error('Error:', reqType, intent, msg || err);
    const speak = speakerOf(h);
    return h.responseBuilder
      .speak(speak(unhandled ? 'didntUnderstand' : 'serverError'))
      .reprompt(speak('noQuery'))
      .getResponse();
  },
};

// ---------------------------------------------------------------------------
// Skill entry point
// ---------------------------------------------------------------------------

exports.handler = Alexa.SkillBuilders.custom()
  .addRequestHandlers(
    LaunchRequestHandler,
    PlayBookIntentHandler,
    ContinueListeningIntentHandler,
    ListInProgressIntentHandler,
    ListLibrariesIntentHandler,
    RecentBooksIntentHandler,
    NextChapterIntentHandler,
    PreviousChapterIntentHandler,
    SeekForwardIntentHandler,
    SeekBackwardIntentHandler,
    SetSleepTimerIntentHandler,
    CancelSleepTimerIntentHandler,
    PauseIntentHandler,
    PlaybackControllerHandler,
    HelpIntentHandler,
    AudioPlayerEventHandler,
    FallbackIntentHandler,
    AmazonBuiltInIntentHandler,
    UnhandledIntentHandler,
    SystemExceptionHandler,
    SessionEndedRequestHandler,
  )
  .addRequestInterceptors(LogRequestInterceptor)
  .addErrorHandlers(ErrorHandler)
  .lambda();

// Exported only for the smoke-test scripts under /tmp.
exports._internals = {
  buildPlayDirective,
  buildEnqueueNextDirective,
  relaunchAtOffset,
  currentPlaybackState,
};
