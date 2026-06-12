(function () {
  "use strict";

  const STORAGE_KEY = "muhurat_flow_session_v1";
  const baseTitle = "Muhurata timer";
  let tickTimer = null;
  let quoteLoadId = 0;
  let settings = null;
  let settingsPromise = null;

  const state = {
    mode: "idle",
    startedAt: null,
    runStartedAt: null,
    focusedSec: 0,
    currentQuote: null,
  };

  function api(path, opts) {
    return fetch(path, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...opts,
    }).then(async (res) => {
      if (!res.ok) throw new Error((await res.text()) || res.statusText);
      return res.json();
    });
  }

  function loadSettings() {
    if (settings) return Promise.resolve(settings);
    if (!settingsPromise) {
      settingsPromise = api("/api/settings")
        .then((data) => {
          settings = data || {};
          return settings;
        })
        .catch(() => {
          settings = {};
          return settings;
        });
    }
    return settingsPromise;
  }

  function playWorkBeginChime() {
    loadSettings().then((current) => window.FocusSounds?.start(current));
  }

  function playWorkCompleteChime() {
    loadSettings().then((current) => window.FocusSounds?.workComplete(current));
  }

  function readStored() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function persist() {
    try {
      if (state.mode === "idle") {
        localStorage.removeItem(STORAGE_KEY);
        sessionStorage.removeItem(STORAGE_KEY);
        return;
      }
      const payload = { ...state, savedAt: Date.now() };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  function restore() {
    const saved = readStored();
    if (!saved || !["running", "paused"].includes(saved.mode) || !saved.startedAt) return;
    state.mode = saved.mode;
    state.startedAt = Number(saved.startedAt) || null;
    state.runStartedAt = saved.mode === "running" ? Number(saved.runStartedAt || saved.savedAt || Date.now()) : null;
    state.focusedSec = Math.max(0, Number(saved.focusedSec || 0));
    state.currentQuote = saved.currentQuote || null;
    applyQuote(state.currentQuote);
  }

  function formatDuration(sec, options = {}) {
    const rounded = Math.max(0, Math.floor(sec));
    const h = Math.floor(rounded / 3600);
    const m = Math.floor((rounded % 3600) / 60);
    const s = rounded % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    if (options.padded) return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function focusedSec() {
    const live = state.mode === "running" && state.runStartedAt ? (Date.now() - state.runStartedAt) / 1000 : 0;
    return state.focusedSec + live;
  }

  function elapsedSec() {
    return state.startedAt ? (Date.now() - state.startedAt) / 1000 : 0;
  }

  function productivity() {
    const elapsed = elapsedSec();
    if (!state.startedAt || elapsed < 0.5) return null;
    return Math.min(100, (focusedSec() / elapsed) * 100);
  }

  function readDisplayedQuote() {
    const quote = document.getElementById("flowQuoteText")?.textContent?.trim();
    const author = document.getElementById("flowQuoteAuthor")?.textContent?.trim();
    return quote && author ? { quote, author } : null;
  }

  function applyQuote(quote) {
    if (!quote?.quote || !quote?.author) return;
    const quoteEl = document.getElementById("flowQuoteText");
    const authorEl = document.getElementById("flowQuoteAuthor");
    if (!quoteEl || !authorEl) return;
    quoteEl.textContent = quote.quote;
    authorEl.textContent = quote.author;
  }

  async function loadQuote() {
    const loadId = ++quoteLoadId;
    const wrap = document.getElementById("flowQuote");
    try {
      const res = await api("/api/quote");
      if (loadId !== quoteLoadId || !res?.quote || !res?.author) return;
      wrap?.classList.add("is-updating");
      state.currentQuote = { quote: res.quote, author: res.author };
      applyQuote(state.currentQuote);
      persist();
      window.setTimeout(() => wrap?.classList.remove("is-updating"), 260);
    } catch (_) {}
  }

  function renderStats() {
    const focused = focusedSec();
    const elapsed = elapsedSec();
    const pct = productivity();
    const focusedEl = document.getElementById("flowFocusedDisplay");
    const elapsedEl = document.getElementById("flowElapsedDisplay");
    const productivityEl = document.getElementById("flowProductivityDisplay");
    if (focusedEl) focusedEl.textContent = formatDuration(focused);
    if (elapsedEl) elapsedEl.textContent = formatDuration(elapsed);
    if (productivityEl) productivityEl.textContent = pct == null ? "—" : `${pct.toFixed(1)}%`;
  }

  function renderTimer() {
    const timeEl = document.getElementById("flowTimeDisplay");
    const labelEl = document.getElementById("flowPhaseLabel");
    const hintEl = document.getElementById("flowHint");
    const wrap = document.getElementById("flowRingWrap");
    const focused = focusedSec();

    if (timeEl) timeEl.textContent = formatDuration(focused, { padded: true });
    if (labelEl) labelEl.textContent = state.mode === "paused" ? "Paused" : "Flow";
    if (hintEl) {
      if (state.mode === "idle") hintEl.textContent = "Start when ready";
      else if (state.mode === "paused") hintEl.textContent = "Pressure-free pause";
      else hintEl.textContent = "Open focus";
    }
    wrap?.classList.toggle("is-flowing", state.mode === "running");
  }

  function renderControls() {
    const start = document.getElementById("btnFlowStart");
    const pause = document.getElementById("btnFlowPause");
    const resume = document.getElementById("btnFlowResume");
    const stop = document.getElementById("btnFlowStop");
    start?.classList.toggle("hidden", state.mode !== "idle");
    pause?.classList.toggle("hidden", state.mode !== "running");
    resume?.classList.toggle("hidden", state.mode !== "paused");
    stop?.classList.toggle("hidden", state.mode === "idle");
  }

  function updateTitle() {
    if (state.mode === "idle") {
      document.title = baseTitle;
      return;
    }
    document.title = `${formatDuration(focusedSec(), { padded: true })} flow${state.mode === "paused" ? " paused" : ""}`;
  }

  function render() {
    renderStats();
    renderTimer();
    renderControls();
    updateTitle();
  }

  function startTicking() {
    stopTicking();
    tickTimer = window.setInterval(() => {
      render();
      persist();
    }, 250);
    render();
  }

  function stopTicking() {
    if (tickTimer) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function startFlow() {
    const now = Date.now();
    state.mode = "running";
    state.startedAt = now;
    state.runStartedAt = now;
    state.focusedSec = 0;
    state.currentQuote = readDisplayedQuote();
    playWorkBeginChime();
    loadQuote();
    startTicking();
    persist();
  }

  function pauseFlow() {
    if (state.mode !== "running") return;
    if (state.runStartedAt) state.focusedSec += Math.max(0, (Date.now() - state.runStartedAt) / 1000);
    state.mode = "paused";
    state.runStartedAt = null;
    startTicking();
    render();
    persist();
  }

  function resumeFlow() {
    if (state.mode !== "paused") return;
    state.mode = "running";
    state.runStartedAt = Date.now();
    playWorkBeginChime();
    loadQuote();
    startTicking();
    persist();
  }

  function stopFlow() {
    if (state.mode !== "idle") playWorkCompleteChime();
    if (state.mode === "running" && state.runStartedAt) {
      state.focusedSec += Math.max(0, (Date.now() - state.runStartedAt) / 1000);
    }
    state.mode = "idle";
    state.startedAt = null;
    state.runStartedAt = null;
    state.focusedSec = 0;
    stopTicking();
    render();
    persist();
  }

  function wireControls() {
    document.getElementById("btnFlowStart")?.addEventListener("click", startFlow);
    document.getElementById("btnFlowPause")?.addEventListener("click", pauseFlow);
    document.getElementById("btnFlowResume")?.addEventListener("click", resumeFlow);
    document.getElementById("btnFlowStop")?.addEventListener("click", stopFlow);
    window.addEventListener("beforeunload", persist);
    document.addEventListener("visibilitychange", () => {
      render();
      persist();
    });
  }

  function init() {
    restore();
    loadSettings();
    wireControls();
    render();
    if (state.mode === "running") startTicking();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
