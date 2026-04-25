'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { AbsClient, fromEnv, resolveApiKey } = require('../lib/absClient');

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

test('resolveApiKey: device-mapped key wins over default', () => {
  const env = {
    ABS_API_KEY: 'default-key',
    ABS_USERS: JSON.stringify({ 'dev-alice': 'key-alice', 'dev-bob': { apiKey: 'key-bob' } }),
  };
  assert.deepEqual(resolveApiKey(env, 'dev-alice'), { apiKey: 'key-alice', source: 'mapped' });
  assert.deepEqual(resolveApiKey(env, 'dev-bob'), { apiKey: 'key-bob', source: 'mapped' });
});

test('resolveApiKey: unmapped device falls back to ABS_API_KEY', () => {
  const env = {
    ABS_API_KEY: 'default-key',
    ABS_USERS: JSON.stringify({ 'dev-alice': 'key-alice' }),
  };
  assert.deepEqual(resolveApiKey(env, 'dev-unknown'), { apiKey: 'default-key', source: 'default' });
  assert.deepEqual(resolveApiKey(env, null), { apiKey: 'default-key', source: 'default' });
});

test('resolveApiKey: returns null when no map entry and no default', () => {
  const env = { ABS_USERS: JSON.stringify({ 'dev-alice': 'key-alice' }) };
  assert.equal(resolveApiKey(env, 'dev-unknown'), null);
});

test('resolveApiKey: malformed ABS_USERS is ignored, falls back to default', () => {
  const env = { ABS_API_KEY: 'default-key', ABS_USERS: 'not-json' };
  assert.deepEqual(resolveApiKey(env, 'dev-x'), { apiKey: 'default-key', source: 'default' });
});

test('fromEnv: throws ABS_NO_KEY with deviceId when nothing matches', () => {
  const env = { ABS_BASE_URL: 'https://abs.example.com', ABS_USERS: '{}' };
  try {
    fromEnv(env, { deviceId: 'dev-x' });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.code, 'ABS_NO_KEY');
    assert.equal(err.deviceId, 'dev-x');
  }
});

test('fromEnv: returns client tagged with key source', () => {
  const env = {
    ABS_BASE_URL: 'https://abs.example.com',
    ABS_API_KEY: 'default-key',
    ABS_USERS: JSON.stringify({ 'dev-alice': 'key-alice' }),
  };
  assert.equal(fromEnv(env, { deviceId: 'dev-alice' }).keySource, 'mapped');
  assert.equal(fromEnv(env, { deviceId: 'dev-other' }).keySource, 'default');
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
