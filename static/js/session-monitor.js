(function () {
  "use strict";

  const SESSION_STORAGE_KEY = "muhurat_timer_session_v1";
  const baseTitle = "Muhurata timer";
  let settings = null;
  let monitorTimer = null;
  const pendingSounds = new Set();

  function readSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function writeSession(data) {
    try {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(data));
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

  function titleSuffix(mode) {
    if (mode === "work" || mode === "extend" || mode === "idle") return "focus";
    if (mode === "rest" || mode === "cumulative") return "rest";
    if (mode === "work_choice") return "break";
    return "timer";
  }

  function phaseKey(data) {
    if (data.phaseNotificationKey) return data.phaseNotificationKey;
    if (!data.phaseEndsAt) return null;
    return `${data.mode}:${data.phaseIndex}:${Math.round(data.phaseEndsAt)}`;
  }

  function syncTitle(data) {
    if (!data?.session?.active || data.mode === "idle") {
      document.title = baseTitle;
      return;
    }
    if (data.mode === "extend") {
      const started = Number(data.session?.segStartedAt || Date.now());
      const base = Number(data.extendBaseSec || 0);
      document.title = `+${formatClock((Date.now() - started) / 1000 + base)} focus`;
      return;
    }
    const end = Number(data.phaseEndsAt || 0);
    const remaining = data.running && end ? (end - Date.now()) / 1000 : Number(data.remainingSec || 0);
    document.title = `${formatClock(remaining)} ${titleSuffix(data.mode)}`;
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
    if (window.__PAGE__ === "home") return;
    const data = readSession();
    syncTitle(data);
    playDueSound(data);
  }

  function start() {
    if (window.__PAGE__ === "home") return;
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
