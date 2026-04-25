'use strict';

// Locale-aware response strings. Keep keys short; values are functions or
// plain strings. Falls back to en-US if a key is missing in the requested
// locale.

const en = {
  welcome: 'Welcome to Audiobookshelf. You can say "play" followed by a book title, or "continue" to resume where you left off. What would you like to do?',
  help: 'Try: "play The Hobbit", "continue listening", "next chapter", "skip 30 seconds back", or "set a sleep timer for 30 minutes". You can also say "stop" at any time.',
  goodbye: 'Goodbye.',
  notConfigured: 'The skill is not configured yet. Please set the audiobookshelf base URL and A P I key in the Lambda environment variables.',
  serverError: 'I could not reach your audiobookshelf server right now. Please try again later.',
  noQuery: 'Which book would you like to play?',
  bookNotFound: (q) => `I could not find an audiobook matching ${q}.`,
  playing: (title, author) => author
    ? `Playing ${title} by ${author}.`
    : `Playing ${title}.`,
  resuming: (title) => `Resuming ${title}.`,
  nothingToResume: 'I could not find an audiobook in progress. Try saying "play" followed by a title.',
  recentBooks: (titles) => `Recently added: ${titles.join(', ')}.`,
  noLibraries: 'I could not find any libraries on your audiobookshelf server.',
  libraries: (names) => `Your libraries are: ${names.join(', ')}.`,
  inProgress: (titles) => titles.length
    ? `You are listening to: ${titles.join(', ')}. Say "continue" followed by a title to resume one.`
    : 'You have no audiobooks in progress.',
  notPlaying: 'Nothing is playing right now.',
  noChapters: 'This audiobook does not have chapter markers.',
  movedToChapter: (title) => `Chapter: ${title}.`,
  alreadyAtFirstChapter: 'You are already at the first chapter.',
  alreadyAtLastChapter: 'You are at the last chapter.',
  seekedForward: (n, u) => `Skipped ${n} ${u} forward.`,
  seekedBackward: (n, u) => `Skipped ${n} ${u} back.`,
  sleepTimerSet: (n, u) => `Sleep timer set for ${n} ${u}. Playback will stop at the end of the next track after that.`,
  sleepTimerCancelled: 'Sleep timer cancelled.',
  noSleepTimer: 'There is no active sleep timer.',
};

const de = {
  welcome: 'Willkommen bei Audiobookshelf. Sage zum Beispiel "spiele" und einen Buchtitel, oder "mache weiter", um fortzufahren. Was möchtest du tun?',
  help: 'Du kannst sagen: "spiele Der Hobbit", "mache weiter", "nächstes Kapitel", "spring 30 Sekunden zurück" oder "stelle den Sleep Timer auf 30 Minuten". Mit "Stop" beendest du die Wiedergabe.',
  goodbye: 'Tschüss.',
  notConfigured: 'Der Skill ist noch nicht konfiguriert. Bitte setze die Audiobookshelf-URL und den A P I Schlüssel in den Lambda-Umgebungsvariablen.',
  serverError: 'Ich kann deinen Audiobookshelf-Server gerade nicht erreichen. Bitte versuche es später noch einmal.',
  noQuery: 'Welches Hörbuch soll ich abspielen?',
  bookNotFound: (q) => `Ich habe kein Hörbuch zu ${q} gefunden.`,
  playing: (title, author) => author
    ? `Spiele ${title} von ${author}.`
    : `Spiele ${title}.`,
  resuming: (title) => `Setze ${title} fort.`,
  nothingToResume: 'Ich habe kein angefangenes Hörbuch gefunden. Sage "spiele" gefolgt vom Titel, um zu starten.',
  recentBooks: (titles) => `Zuletzt hinzugefügt: ${titles.join(', ')}.`,
  noLibraries: 'Ich konnte keine Bibliotheken auf deinem Audiobookshelf-Server finden.',
  libraries: (names) => `Deine Bibliotheken sind: ${names.join(', ')}.`,
  inProgress: (titles) => titles.length
    ? `Du hörst gerade: ${titles.join(', ')}. Sage "mache mit" gefolgt vom Titel, um fortzufahren.`
    : 'Du hast keine angefangenen Hörbücher.',
  notPlaying: 'Es läuft gerade nichts.',
  noChapters: 'Dieses Hörbuch hat keine Kapitelmarken.',
  movedToChapter: (title) => `Kapitel: ${title}.`,
  alreadyAtFirstChapter: 'Du bist schon im ersten Kapitel.',
  alreadyAtLastChapter: 'Du bist im letzten Kapitel.',
  seekedForward: (n, u) => `${n} ${u} vorgespult.`,
  seekedBackward: (n, u) => `${n} ${u} zurückgespult.`,
  sleepTimerSet: (n, u) => `Sleep Timer auf ${n} ${u} gesetzt. Die Wiedergabe stoppt am Ende des nächsten Tracks danach.`,
  sleepTimerCancelled: 'Sleep Timer abgebrochen.',
  noSleepTimer: 'Es ist kein Sleep Timer aktiv.',
};

const tables = { 'en-US': en, 'de-DE': de };

function t(locale) {
  const table = tables[locale] || (locale && locale.startsWith('de') ? de : en);
  return (key, ...args) => {
    const v = table[key] != null ? table[key] : en[key];
    return typeof v === 'function' ? v(...args) : v;
  };
}

module.exports = { t };
