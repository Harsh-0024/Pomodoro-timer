(function () {
  "use strict";

  const SESSION_STORAGE_KEY = "muhurat_timer_session_v1";
  const baseTitle = "Muhurata timer";
  let settings = null;
  let monitorTimer = null;
  const pendingSounds = new Set();

  function parseSession(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function readSession() {
    try {
      const local = parseSession(localStorage.getItem(SESSION_STORAGE_KEY));
      const session = parseSession(sessionStorage.getItem(SESSION_STORAGE_KEY));
      if (!local && !session) return null;
      const data = !local
        ? session
        : !session
          ? local
          : Number(session.savedAt || 0) > Number(local.savedAt || 0)
            ? session
            : local;
      if (data) writeSession(data);
      return data;
    } catch (_) {
      return null;
    }
  }

  function writeSession(data) {
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
    } catch (_) {}
  }

  async function loadSettings() {
    if (settings) return settings;
    try {
      const res = await fetch("/api/settings", { headers: { Accept: "application/json" } });
      if (res.ok) settings = await res.json();
    } catch (_) {}
    return settings || {};
  }

  function formatClock(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function phaseKey(data) {
    if (data.phaseNotificationKey) return data.phaseNotificationKey;
    if (!data.phaseEndsAt) return null;
    return `${data.mode}:${data.phaseIndex}:${Math.round(data.phaseEndsAt)}`;
  }

  function remainingForCountdown(data) {
    const end = Number(data.phaseEndsAt || 0);
    if (data.running && end) return (end - Date.now()) / 1000;
    return Number(data.remainingSec || 0);
  }

  function syncTitle(data) {
    if (!data?.session?.active || data.mode === "idle") {
      document.title = baseTitle;
      return;
    }
    if (data.mode === "extend") {
      const started = Number(data.session?.segStartedAt || Date.now());
      const extendSec = Number(data.session?.extendSec || 0);
      const base = Number(data.extendBaseSec || 0);
      const live = data.running ? (Date.now() - started) / 1000 : 0;
      document.title = `+${formatClock(Math.max(0, extendSec + live - base))} focus`;
      return;
    }
    if (data.mode === "complete") {
      document.title = "done";
      return;
    }
    if (data.mode === "work_choice" && data.pendingRest?.sec) {
      document.title = `${formatClock(data.pendingRest.sec)} break`;
      return;
    }
    if (data.mode === "rest_choice") {
      document.title = "ready for focus";
      return;
    }
    const remaining = remainingForCountdown(data);
    if (!data.running) {
      document.title = `${formatClock(remaining)} paused`;
      return;
    }
    const suffix = data.mode === "work" ? "focus" : data.mode === "rest" || data.mode === "cumulative" ? "rest" : "timer";
    document.title = `${formatClock(remaining)} ${suffix}`;
  }

  async function playDueSound(data) {
    if (!data?.running || !data.phaseEndsAt || Date.now() < Number(data.phaseEndsAt)) return;
    if (!["work", "rest", "cumulative"].includes(data.mode)) return;
    const key = phaseKey(data);
    if (!key || data.monitorNotifiedPhase === key) return;
    if (pendingSounds.has(key)) return;
    pendingSounds.add(key);
    const current = await loadSettings();
    try {
      if (data.mode === "work") await window.FocusSounds?.workComplete(current);
      else await window.FocusSounds?.breakComplete(current);
      data.phaseNotificationKey = key;
      data.monitorNotifiedPhase = key;
      writeSession(data);
    } catch (_) {
    } finally {
      pendingSounds.delete(key);
    }
  }

  function tick() {
    if (window.__PAGE__ === "home" || window.__PAGE__ === "flow") return;
    const data = readSession();
    syncTitle(data);
    playDueSound(data);
  }

  function start() {
    if (window.__PAGE__ === "home" || window.__PAGE__ === "flow") return;
    tick();
    monitorTimer = window.setInterval(tick, 500);
    document.addEventListener("visibilitychange", tick);
    window.addEventListener("focus", tick);
    window.addEventListener("storage", tick);
  }

  document.addEventListener("DOMContentLoaded", start);
  window.MuhurataSessionMonitor = {
    refreshSettings() {
      settings = null;
      return loadSettings();
    },
    stop() {
      if (monitorTimer) window.clearInterval(monitorTimer);
    },
  };
})();
