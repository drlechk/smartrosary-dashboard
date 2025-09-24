// state.js
export const appState = {
  lang: 'pl',
  lastStats: null,
  lastSettings: null,

  // BLE refs
  device: null,
  server: null,
  service: null,
  ch: {
    stats: null, settings: null, ctrl: null, parts: null,
    authInfo: null, authCtrl: null, status: null,
    touch: null, keys: null
  },
  consentOk: false,
  readyFlag: true, // pacing
  updatingFromDevice: false
};