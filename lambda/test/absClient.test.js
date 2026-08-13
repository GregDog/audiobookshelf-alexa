'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AbsClient } = require('../lib/absClient');

function fakeFetch(record, opts = {}) {
  return async (url, init) => {
    record.push({ url, init });
    const headers = new Map(Object.entries(opts.headers || { 'content-type': 'application/json' }));
    return {
      ok: opts.ok !== false,
      status: opts.status || 200,
      headers: { get: (k) => headers.get(k.toLowerCase()) },
      json: async () => ({ url, body: init.body ? JSON.parse(init.body) : null }),
      text: async () => opts.text || '',
    };
  };
}

test('constructor strips trailing slashes from baseUrl', () => {
  const c = new AbsClient({ baseUrl: 'https://abs.example.com///', apiKey: 'k' });
  assert.equal(c.baseUrl, 'https://abs.example.com');
});

test('constructor requires baseUrl and apiKey', () => {
  assert.throws(() => new AbsClient({ apiKey: 'k' }));
  assert.throws(() => new AbsClient({ baseUrl: 'x' }));
});

test('streamUrlFor builds absolute URL with token', () => {
  const c = new AbsClient({ baseUrl: 'https://abs.example.com', apiKey: 'secret' });
  assert.equal(
    c.streamUrlFor('/s/item/abc/track1.mp3'),
    'https://abs.example.com/s/item/abc/track1.mp3?token=secret',
  );
  assert.equal(
    c.streamUrlFor('/s/item/abc/track1.mp3?foo=1'),
    'https://abs.example.com/s/item/abc/track1.mp3?foo=1&token=secret',
  );
  assert.equal(
    c.streamUrlFor('https://cdn.example.com/x.mp3'),
    'https://cdn.example.com/x.mp3?token=secret',
  );
});

test('streamUrlFor adds Alexa-friendly extension when ABS path has none', () => {
  const c = new AbsClient({ baseUrl: 'https://abs.example.com', apiKey: 'secret' });
  assert.equal(
    c.streamUrlFor('/api/items/abc/file/123', 'audio/mp4'),
    'https://abs.example.com/api/items/abc/file/123.mp4?token=secret',
  );
  assert.equal(
    c.streamUrlFor('/api/items/abc/file/123', 'audio/mpeg'),
    'https://abs.example.com/api/items/abc/file/123.mp3?token=secret',
  );
});

test('request sends bearer auth header and JSON body', async () => {
  const calls = [];
  const c = new AbsClient({ baseUrl: 'https://abs.example.com', apiKey: 'k', fetchImpl: fakeFetch(calls) });
  await c.request('/api/x', { method: 'POST', body: { a: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://abs.example.com/api/x');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer k');
  assert.equal(calls[0].init.body, JSON.stringify({ a: 1 }));
});

test('request returns text wrapper when response is not JSON', async () => {
  const calls = [];
  const c = new AbsClient({
    baseUrl: 'https://abs.example.com',
    apiKey: 'k',
    fetchImpl: fakeFetch(calls, { headers: { 'content-type': 'text/plain' }, text: 'OK' }),
  });
  const out = await c.syncSession('sess-1', { currentTime: 10, duration: 100 });
  assert.deepEqual(out, { ok: true, body: 'OK' });
});

test('startPlaybackSession posts expected body', async () => {
  const calls = [];
  const c = new AbsClient({ baseUrl: 'https://abs.example.com', apiKey: 'k', fetchImpl: fakeFetch(calls) });
  await c.startPlaybackSession('item-1');
  assert.equal(calls[0].url, 'https://abs.example.com/api/items/item-1/play');
  assert.equal(calls[0].init.method, 'POST');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.forceDirectPlay, true);
  assert.equal(body.mediaPlayer, 'AlexaAudioPlayer');
  assert.ok(Array.isArray(body.supportedMimeTypes));
});
