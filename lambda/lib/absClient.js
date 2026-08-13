'use strict';

const dns = require('dns');
// Node 17+ prefers IPv6; Lambda egress is IPv4-only in many regions. Without
// this, fetch() can hang until the Lambda timeout when Cloudflare publishes AAAA.
dns.setDefaultResultOrder('ipv4first');

const FETCH_TIMEOUT_MS = 8000;

// Thin client for the audiobookshelf HTTP API.
// Docs: https://api.audiobookshelf.org/
//
// Auth is a long-lived API key (Settings -> Users -> API Keys in the
// audiobookshelf web UI). API keys created in 2.26+ are JWTs and work
// both as `Authorization: Bearer <key>` for API calls and as `?token=<key>`
// for stream URLs.

class AbsClient {
  constructor({ baseUrl, apiKey, fetchImpl } = {}) {
    if (!baseUrl) throw new Error('AbsClient: baseUrl is required');
    if (!apiKey) throw new Error('AbsClient: apiKey is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.fetch = fetchImpl || globalThis.fetch;
  }

  async request(path, { method = 'GET', body } = {}) {
    const url = `${this.baseUrl}${path}`;
    const res = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'audiobookshelf-alexa/0.1',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`audiobookshelf ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    // Some endpoints (e.g. /api/session/<id>/sync) reply with plain text
    // like "OK" instead of JSON. Decide based on Content-Type.
    const ctype = (res.headers.get && res.headers.get('content-type')) || '';
    if (ctype.includes('application/json')) return res.json();
    const text = await res.text().catch(() => '');
    return { ok: true, body: text };
  }

  listLibraries() {
    return this.request('/api/libraries');
  }

  // Filtered listing of items in a library. The audiobookshelf "filter" param
  // expects a base64-encoded string like "authors.<base64(name)>" — for plain
  // listings we just paginate.
  listItems(libraryId, { limit = 50, page = 0, sort = 'addedAt', desc = 1 } = {}) {
    const qs = new URLSearchParams({
      limit: String(limit),
      page: String(page),
      sort,
      desc: String(desc),
    });
    return this.request(`/api/libraries/${libraryId}/items?${qs}`);
  }

  // Server-side text search across a library. Returns { book: [...], podcast: [...] }.
  search(libraryId, query, { limit = 5 } = {}) {
    const qs = new URLSearchParams({ q: query, limit: String(limit) });
    return this.request(`/api/libraries/${libraryId}/search?${qs}`);
  }

  getItem(itemId) {
    return this.request(`/api/items/${itemId}?expanded=1&include=progress`);
  }

  // POST /api/items/<id>/play -> { id (sessionId), audioTracks: [...], ... }
  // audioTracks[i].contentUrl is a server-relative path; build the absolute
  // streamable URL with streamUrlFor() below.
  startPlaybackSession(itemId, { episodeId, deviceInfo = {}, supportedMimeTypes } = {}) {
    const body = {
      deviceInfo: {
        clientName: 'audiobookshelf-alexa',
        clientVersion: '0.1.0',
        manufacturer: 'Amazon',
        model: 'Alexa',
        ...deviceInfo,
      },
      forceDirectPlay: true,
      mediaPlayer: 'AlexaAudioPlayer',
      supportedMimeTypes: supportedMimeTypes || ['audio/mpeg', 'audio/mp4', 'audio/aac'],
    };
    const path = episodeId
      ? `/api/items/${itemId}/play/${episodeId}`
      : `/api/items/${itemId}/play`;
    return this.request(path, { method: 'POST', body });
  }

  // Sync progress for an active playback session.
  // currentTime and timeListened are in seconds.
  syncSession(sessionId, { currentTime, timeListened = 0, duration }) {
    return this.request(`/api/session/${sessionId}/sync`, {
      method: 'POST',
      body: { currentTime, timeListened, duration },
    });
  }

  // /api/me returns the authenticated user, including mediaProgress[] which
  // lists in-progress items with currentTime, duration, isFinished, etc.
  getMe() {
    return this.request('/api/me');
  }

  // Build an absolute, authenticated stream URL for Echo's AudioPlayer.
  // ABS paths are extensionless; Echo picks codec from the URL suffix, so we
  // add a fake extension that Caddy strips before proxying to Audiobookshelf.
  streamUrlFor(contentUrl, mimeType) {
    let absolute = contentUrl.startsWith('http')
      ? contentUrl
      : `${this.baseUrl}${contentUrl.startsWith('/') ? '' : '/'}${contentUrl}`;
    absolute = this.withAlexaStreamExtension(absolute, mimeType);
    const sep = absolute.includes('?') ? '&' : '?';
    return `${absolute}${sep}token=${encodeURIComponent(this.apiKey)}`;
  }

  withAlexaStreamExtension(url, mimeType) {
    const qIndex = url.indexOf('?');
    const base = qIndex === -1 ? url : url.slice(0, qIndex);
    const query = qIndex === -1 ? '' : url.slice(qIndex);
    if (/\.(mp3|m4a|m4b|mp4|aac|ogg)$/i.test(base)) return url;
    const type = String(mimeType || '').toLowerCase();
    const ext = type.includes('mpeg') ? '.mp3'
      : (type.includes('mp4') || type.includes('aac') ? '.m4b' : '.mp3');
    return `${base}${ext}${query}`;
  }
}

function fromEnv(env = process.env) {
  return new AbsClient({
    baseUrl: env.ABS_BASE_URL,
    apiKey: env.ABS_API_KEY,
  });
}

module.exports = { AbsClient, fromEnv };
