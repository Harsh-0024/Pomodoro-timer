// In the Mac app's own window (macOS's web view, not a browser) there are no
// web notifications, so hand them to the app, which shows them instead.
// In a browser this does nothing. Loaded before the other scripts, which
// read window.Notification.
(function () {
  "use strict";
  if (!window.webkit || !window.webkit.messageHandlers) return; // a browser

  function send(title, body) {
    try {
      window.pywebview.api.notify(String(title), String(body || ""));
    } catch (_) {}
  }

  window.Notification = class {
    constructor(title, options) {
      send(title, options && options.body);
    }
    static get permission() {
      return "granted";
    }
    static requestPermission() {
      return Promise.resolve("granted");
    }
  };
})();
