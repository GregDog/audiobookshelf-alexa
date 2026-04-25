'use strict';

// Builders for Alexa request envelopes plus a Promise-friendly invoker.
// The handler exported by index.js is a Lambda-style callback function;
// invoke() wraps it.

const { encodeToken } = require('../../lib/playback');

const APP_ID = 'amzn1.ask.skill.test';
const USER_ID = 'amzn1.ask.account.test';

function baseEnvelope({ locale = 'de-DE', audioPlayer } = {}) {
  return {
    version: '1.0',
    session: {
      new: true,
      sessionId: 'sess-1',
      application: { applicationId: APP_ID },
      user: { userId: USER_ID },
      attributes: {},
    },
    context: {
      System: {
        application: { applicationId: APP_ID },
        user: { userId: USER_ID },
        device: {
          deviceId: 'dev-1',
          supportedInterfaces: { AudioPlayer: {} },
        },
      },
      AudioPlayer: audioPlayer || { playerActivity: 'IDLE' },
    },
    request: { type: 'LaunchRequest', requestId: `req-${Date.now()}`, timestamp: new Date().toISOString(), locale },
  };
}

function launch(opts = {}) { return baseEnvelope(opts); }

function intent(name, slots = {}, opts = {}) {
  const env = baseEnvelope(opts);
  env.request = {
    type: 'IntentRequest',
    requestId: `req-${Date.now()}`,
    timestamp: new Date().toISOString(),
    locale: opts.locale || 'de-DE',
    intent: {
      name,
      confirmationStatus: 'NONE',
      slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, {
        name: k,
        value: typeof v === 'object' ? v.value : String(v),
        confirmationStatus: 'NONE',
      }])),
    },
  };
  return env;
}

function audioPlayerEvent(eventName, { token, offsetInMilliseconds = 0, locale = 'de-DE' } = {}) {
  return {
    version: '1.0',
    context: {
      System: {
        application: { applicationId: APP_ID },
        user: { userId: USER_ID },
        device: { deviceId: 'dev-1', supportedInterfaces: { AudioPlayer: {} } },
      },
      AudioPlayer: { token, offsetInMilliseconds, playerActivity: 'PLAYING' },
    },
    request: {
      type: `AudioPlayer.${eventName}`,
      requestId: `req-${Date.now()}`,
      timestamp: new Date().toISOString(),
      locale,
      token,
      offsetInMilliseconds,
    },
  };
}

function playbackController(command, { token, offsetInMilliseconds = 0, locale = 'de-DE' } = {}) {
  return {
    version: '1.0',
    context: {
      System: {
        application: { applicationId: APP_ID },
        user: { userId: USER_ID },
        device: { deviceId: 'dev-1', supportedInterfaces: { AudioPlayer: {} } },
      },
      AudioPlayer: { token, offsetInMilliseconds, playerActivity: 'PLAYING' },
    },
    request: {
      type: `PlaybackController.${command}CommandIssued`,
      requestId: `req-${Date.now()}`,
      timestamp: new Date().toISOString(),
      locale,
    },
  };
}

// Convenience: build an AudioPlayer context block for an in-flight track.
function audioPlayerCtx({ tokenState, offsetMs = 0, playerActivity = 'PLAYING' }) {
  return { token: encodeToken(tokenState), offsetInMilliseconds: offsetMs, playerActivity };
}

// Promisify the Lambda-style callback handler exported from index.js.
function invoke(handler, envelope) {
  return new Promise((resolve, reject) => {
    handler(envelope, {}, (err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

// Helpers for common assertions on responses.
function speech(res) {
  return res && res.response && res.response.outputSpeech && res.response.outputSpeech.ssml;
}

function directives(res) {
  return (res && res.response && res.response.directives) || [];
}

function playDirective(res) {
  return directives(res).find((d) => d.type === 'AudioPlayer.Play');
}

function stopDirective(res) {
  return directives(res).find((d) => d.type === 'AudioPlayer.Stop');
}

module.exports = {
  baseEnvelope,
  launch,
  intent,
  audioPlayerEvent,
  audioPlayerCtx,
  playbackController,
  invoke,
  speech,
  directives,
  playDirective,
  stopDirective,
};
