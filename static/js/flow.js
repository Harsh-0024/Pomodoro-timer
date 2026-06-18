(function () {
  "use strict";

  const STORAGE_KEY = "muhurat_flow_session_v1";
  const TIMER_STORAGE_KEY = "muhurat_timer_session_v1";
  const SESSION_COMMAND_KEY = "muhurat_session_command_v1";
  const ACTIVE_TIMER_MODES = new Set(["work", "extend", "rest", "cumulative"]);
  const baseTitle = "Muhurata timer";
  let tickTimer = null;
  let quoteLoadId = 0;
  let settings = null;
  let settingsPromise = null;
  let presetPromise = null;
  let noticeTimer = null;

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

  function localDayISO(ms) {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function playWorkBeginChime() {
    loadSettings().then((current) => window.FocusSounds?.start(current));
  }

  function playWorkCompleteChime() {
    loadSettings().then((current) => window.FocusSounds?.workComplete(current));
  }

  function logFlowSegment(startedAt, endedAt) {
    const durationSec = Math.max(0, (endedAt - startedAt) / 1000);
    if (durationSec < 0.5) return;
    api("/api/activity/segment", {
      method: "POST",
      body: JSON.stringify({
        day: localDayISO(startedAt),
        kind: "flow",
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        duration_sec: durationSec,
        preset_id: "flow",
        preset_name: "Flow",
        details: { mode: "stopwatch" },
      }),
    }).catch(() => {});
  }

  function logTimerSegment(data, kind, startedAt, endedAt, details = {}) {
    const durationSec = Math.max(0, (endedAt - startedAt) / 1000);
    if (durationSec < 0.5) return;
    api("/api/activity/segment", {
      method: "POST",
      body: JSON.stringify({
        day: localDayISO(startedAt),
        kind,
        started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt).toISOString(),
        duration_sec: durationSec,
        preset_id: data.presetId || "",
        preset_name: data.presetName || "",
        phase_index: data.phaseIndex,
        details,
      }),
    }).catch(() => {});
  }

  function showNotice(message) {
    const el = document.getElementById("flowNotice");
    if (!el || !message) return;
    el.textContent = message;
    el.classList.remove("hidden");
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      el.classList.add("hidden");
      el.textContent = "";
    }, 5200);
  }

  function parseStored(raw) {
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  function readStoredTimer() {
    const local = parseStored(localStorage.getItem(TIMER_STORAGE_KEY));
    const session = parseStored(sessionStorage.getItem(TIMER_STORAGE_KEY));
    if (!local) return session;
    if (!session) return local;
    return Number(session.savedAt || 0) > Number(local.savedAt || 0) ? session : local;
  }

  function writeStoredTimer(data) {
    try {
      const raw = JSON.stringify(data);
      localStorage.setItem(TIMER_STORAGE_KEY, raw);
      sessionStorage.setItem(TIMER_STORAGE_KEY, raw);
      localStorage.setItem(
        SESSION_COMMAND_KEY,
        JSON.stringify({ target: "timer", action: "paused-by-flow", at: Date.now() })
      );
    } catch (_) {}
  }

  function loadPresets() {
    if (!presetPromise) {
      presetPromise = api("/api/presets")
        .then((data) => [...(data.builtins || []), ...(data.custom || [])])
        .catch(() => []);
    }
    return presetPromise;
  }

  function timerPreset(data, presets) {
    return presets.find((preset) => preset.id === data?.presetId) || null;
  }

  function restAccrualRate(preset) {
    if (!preset) return 0;
    const workSec = 4 * Number(preset.work_min || 0) * 60;
    const restSec = (3 * Number(preset.short_rest_min || 0) + Number(preset.long_rest_min || 0)) * 60;
    return workSec > 0 ? restSec / workSec : 0;
  }

  function syncStoredExtendPool(data, preset, now) {
    if (data.mode !== "extend" || !preset || !data.session) return;
    const session = data.session;
    const live = session.segKind === "extend" && session.segStartedAt ? Math.max(0, (now - Number(session.segStartedAt)) / 1000) : 0;
    const extendTotal = Number(session.extendSec || 0) + live;
    const target = extendTotal * restAccrualRate(preset);
    const previous = Number(session.extendPoolAccrued || 0);
    const delta = target - previous;
    if (delta > 0.001) {
      session.extendPoolAccrued = target;
      session.poolSec = Number(session.poolSec || 0) + delta;
    }
  }

  function commitStoredTimerSegment(data, preset, now) {
    const session = data.session;
    if (!session?.segStartedAt || !session.segKind) return;
    if (session.segKind === "extend") syncStoredExtendPool(data, preset, now);
    const startedAt = Number(session.segStartedAt);
    const endedAt = now;
    const elapsed = Math.max(0, (endedAt - startedAt) / 1000);
    if (session.segKind === "work") session.workSec = Number(session.workSec || 0) + elapsed;
    else if (session.segKind === "extend") session.extendSec = Number(session.extendSec || 0) + elapsed;
    else if (session.segKind === "rest" || session.segKind === "cumulative")
      session.restTakenSec = Number(session.restTakenSec || 0) + elapsed;
    logTimerSegment(data, session.segKind, startedAt, endedAt, {
      duration_sec: Number(session.segDurationSec || 0),
      paused_by: "flow",
    });
    session.segStartedAt = null;
    session.segKind = null;
    session.segDurationSec = 0;
  }

  async function pauseTimerForFlow() {
    const data = readStoredTimer();
    if (!data?.running || !ACTIVE_TIMER_MODES.has(data.mode) || !data?.session?.active) return false;
    const now = Date.now();
    const presets = await loadPresets();
    const preset = timerPreset(data, presets);
    if (preset) data.presetName = preset.name || "";
    if (data.phaseEndsAt) data.remainingSec = Math.max(0, (Number(data.phaseEndsAt) - now) / 1000);
    commitStoredTimerSegment(data, preset, now);
    data.running = false;
    data.phaseEndsAt = null;
    data.pauseStartedAt = now;
    data.pausedBy = "flow";
    data.notice = "Timer paused while Flow starts.";
    data.savedAt = now;
    writeStoredTimer(data);
    showNotice(data.notice);
    return true;
  }

  function readStored() {
    try {
      return parseStored(localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(STORAGE_KEY));
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
    applyStoredFlow(saved, false);
  }

  function applyStoredFlow(saved, fromExternal) {
    if (!saved || !["running", "paused"].includes(saved.mode) || !saved.startedAt) return;
    state.mode = saved.mode;
    state.startedAt = Number(saved.startedAt) || null;
    state.runStartedAt = saved.mode === "running" ? Number(saved.runStartedAt || saved.savedAt || Date.now()) : null;
    state.focusedSec = Math.max(0, Number(saved.focusedSec || 0));
    state.currentQuote = saved.currentQuote || null;
    applyQuote(state.currentQuote);
    if (fromExternal && saved.notice) showNotice(saved.notice);
    render();
    if (state.mode === "running") startTicking();
    else if (state.mode === "paused") startTicking();
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

  async function startFlow() {
    await pauseTimerForFlow();
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
    const now = Date.now();
    if (state.runStartedAt) {
      state.focusedSec += Math.max(0, (now - state.runStartedAt) / 1000);
      logFlowSegment(state.runStartedAt, now);
    }
    state.mode = "paused";
    state.runStartedAt = null;
    startTicking();
    render();
    persist();
  }

  async function resumeFlow() {
    if (state.mode !== "paused") return;
    await pauseTimerForFlow();
    state.mode = "running";
    state.runStartedAt = Date.now();
    playWorkBeginChime();
    loadQuote();
    startTicking();
    persist();
  }

  function stopFlow() {
    const now = Date.now();
    if (state.mode !== "idle") playWorkCompleteChime();
    if (state.mode === "running" && state.runStartedAt) {
      state.focusedSec += Math.max(0, (now - state.runStartedAt) / 1000);
      logFlowSegment(state.runStartedAt, now);
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
    window.addEventListener("storage", (event) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      applyStoredFlow(parseStored(event.newValue), true);
    });
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
