// iPhone web app alerts (alerts.js is the Android app's).
//
// iOS stops a web app as soon as it leaves the screen, and a web app cannot
// book a notification for later the way the Android app does. So:
//
// - While Rhythm or the Timer is counting down, the screen is kept on (Screen
//   Wake Lock), so the end-of-block bell rings as on a computer. Locking the
//   phone is still fine: the clocks run on timestamps, so on return the timer
//   is exactly where it should be and catches up on what it missed.
// - Web notifications are switched off: they would only ever show while the
//   app is already open, and asking for them would be a pointless prompt.
//   Settings hides its Notifications section (mobile.js reads L.notifications).
(function () {
  "use strict";

  const L = window.__MUHURTA_LOCAL__;
  if (!L) return;
  L.notifications = false;
  try {
    delete window.Notification;
  } catch (_) {}

  // Rhythm's saved session is still called "timer"; the simple Timer's is "countdown".
  const TIMER_KEY = "muhurat_timer_session_v1";
  const COUNTDOWN_KEY = "muhurat_countdown_session_v1";

  function saved(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch (_) {
      return null;
    }
  }

  function counting() {
    const rhythm = saved(TIMER_KEY);
    if (rhythm && rhythm.running && rhythm.phaseEndsAt > Date.now()) return true;
    const countdown = saved(COUNTDOWN_KEY);
    return Boolean(countdown && countdown.mode === "running" && countdown.endsAt > Date.now());
  }

  /* ---------- keep the screen on while a clock counts down ---------- */

  let lock = null;
  let asking = false;

  async function keepAwake() {
    if (!navigator.wakeLock) return;
    const want = counting() && document.visibilityState === "visible";
    if (want && !lock && !asking) {
      asking = true;
      try {
        lock = await navigator.wakeLock.request("screen");
        lock.addEventListener("release", () => (lock = null));
      } catch (_) {
        lock = null; // low battery mode, or not allowed: the timer still works
      } finally {
        asking = false;
      }
    } else if (!want && lock) {
      const l = lock;
      lock = null;
      l.release().catch(() => {});
    }
  }

  // The lock lets go by itself when the app leaves the screen; take it back on return.
  document.addEventListener("visibilitychange", keepAwake);
  L.ready.then(keepAwake);
  // Each start, pause and end saves the clock's state: check then, and now and
  // then for a block that ended on its own.
  const realSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    realSetItem.call(this, key, value);
    if (this === window.localStorage && (key === TIMER_KEY || key === COUNTDOWN_KEY)) keepAwake();
  };
  setInterval(keepAwake, 15000);
})();
