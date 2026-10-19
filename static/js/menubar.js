// In the Mac app, tell the app what is running so it can show the time in
// the menu bar (menubar.py), like Apple's Clock. Runs on every page and reads
// the timer's and Flow's saved sessions, so it works wherever the window is.
// The app counts the seconds itself; this only says when something changes.
// In a browser this does nothing.
(function () {
  "use strict";
  if (!window.webkit || !window.webkit.messageHandlers) return; // a browser

  const TIMER_KEY = "muhurat_timer_session_v1";
  const FLOW_KEY = "muhurat_flow_session_v1";
  let lastSent = null;

  function read(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function timerState(d) {
    if (!d) return null;
    if (d.mode === "extend") {
      const s = d.session || {};
      let sec = Number(s.extendSec || 0) - Number(d.extendBaseSec || 0);
      const open = s.segKind === "extend" && s.segStartedAt;
      if (open && d.running) {
        return { kind: "timer", up: true, sec, since: s.segStartedAt, until: null, paused: false };
      }
      if (open) sec += Math.max(0, (Number(d.savedAt || Date.now()) - s.segStartedAt) / 1000);
      return { kind: "timer", up: true, sec, since: null, until: null, paused: true };
    }
    if (!["work", "rest", "cumulative"].includes(d.mode)) return null;
    if (d.running && d.phaseEndsAt) {
      if (d.phaseEndsAt <= Date.now()) return null;
      return { kind: "timer", up: false, sec: 0, since: null, until: d.phaseEndsAt, paused: false };
    }
    return { kind: "timer", up: false, sec: Number(d.remainingSec || 0), since: null, until: null, paused: true };
  }

  function flowState(d) {
    if (!d || (d.mode !== "running" && d.mode !== "paused")) return null;
    const sec = Number(d.focusedSec || 0);
    if (d.mode === "running" && d.runStartedAt) {
      return { kind: "flow", up: true, sec, since: d.runStartedAt, until: null, paused: false };
    }
    return { kind: "flow", up: true, sec, since: null, until: null, paused: true };
  }

  function current() {
    const timer = timerState(read(TIMER_KEY));
    const flow = flowState(read(FLOW_KEY));
    // Whichever is running wins; if both are paused, Flow (it is the newer).
    if (timer && !timer.paused) return timer;
    if (flow && !flow.paused) return flow;
    return flow || timer;
  }

  function check() {
    const api = window.pywebview && window.pywebview.api;
    if (!api || typeof api.menu_bar !== "function") return;
    const state = current();
    const key = JSON.stringify(state);
    if (key === lastSent) return;
    lastSent = key;
    try {
      api.menu_bar(state);
    } catch (_) {}
  }

  window.setInterval(check, 1000);
  window.addEventListener("pywebviewready", check);
  window.addEventListener("storage", check);
})();
