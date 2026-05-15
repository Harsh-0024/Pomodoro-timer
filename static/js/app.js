(function () {
  "use strict";

  const RING_LEN = 2 * Math.PI * 96;

  /** @type {ReturnType<typeof setInterval> | null} */
  let tickTimer = null;
  /** @type {number | null} */
  let phaseEndsAt = null;
  const baseTitle = document.title;

  const state = {
    presets: [],
    settings: {},
    presetId: null,
    phaseIndex: 0,
    remainingSec: 0,
    running: false,
    lastMinuteBucket: null,
  };

  async function api(path, opts) {
    const r = await fetch(path, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...opts,
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(t || r.statusText);
    }
    if (r.status === 204) return null;
    return r.json();
  }

  function presetById(id) {
    return state.presets.find((p) => p.id === id) || null;
  }

  function phaseKind(i) {
    if (i === 7) return "long";
    if (i % 2 === 0) return "work";
    return "short";
  }

  function phaseDurationSec(p, i) {
    const k = phaseKind(i);
    if (k === "work") return p.work_min * 60;
    if (k === "short") return p.short_rest_min * 60;
    return p.long_rest_min * 60;
  }

  function workBlockNumber(i) {
    if (phaseKind(i) !== "work") return null;
    return i / 2 + 1;
  }

  function formatTime(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  let audioCtx = null;

  async function ensureAudio() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") {
      await audioCtx.resume();
    }
  }

  function tone(freq, start, dur, vol, type) {
    if (!audioCtx || !state.settings.sound_enabled) return;
    const t0 = audioCtx.currentTime + start;
    const osc = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  function playWorkCompleteChime() {
    if (!state.settings.sound_enabled || !state.settings.chime_work_end) return;
    ensureAudio()
      .then(() => {
        tone(523.25, 0, 0.22, 0.14, "sine");
        tone(392.0, 0.12, 0.26, 0.12, "sine");
        tone(329.63, 0.28, 0.4, 0.1, "triangle");
      })
      .catch(() => {});
  }

  function playBreakCompleteChime() {
    if (!state.settings.sound_enabled || !state.settings.chime_break_end) return;
    ensureAudio()
      .then(() => {
        tone(659.25, 0, 0.18, 0.13, "sine");
        tone(880.0, 0.14, 0.32, 0.12, "sine");
      })
      .catch(() => {});
  }

  function playMinutePulse() {
    if (!state.settings.sound_enabled || !state.settings.tick_sound_enabled) return;
    ensureAudio()
      .then(() => {
        tone(220, 0, 0.05, 0.05, "sine");
      })
      .catch(() => {});
  }

  function primeAudio() {
    if (!state.settings.sound_enabled) return;
    ensureAudio()
      .then(() => {
        tone(440, 0, 0.035, 0.025, "sine");
      })
      .catch(() => {});
  }

  function notify(title, body) {
    if (!state.settings.notifications_enabled) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    try {
      new Notification(title, { body, silent: true });
    } catch (_) {}
  }

  async function requestNotifyPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      await Notification.requestPermission();
    }
  }

  function syncRemainingFromClock() {
    if (!state.running || !phaseEndsAt) return;
    state.remainingSec = Math.max(0, (phaseEndsAt - Date.now()) / 1000);
  }

  function armPhaseEnd() {
    phaseEndsAt = Date.now() + state.remainingSec * 1000;
  }

  function disarmPhaseEnd() {
    phaseEndsAt = null;
  }

  function currentPreset() {
    return presetById(state.presetId);
  }

  function applyBodyPhaseClass() {
    const k = phaseKind(state.phaseIndex);
    document.body.classList.remove("rest-short", "rest-long", "focus-work");
    if (k === "short") document.body.classList.add("rest-short");
    else if (k === "long") document.body.classList.add("rest-long");
    else document.body.classList.add("focus-work");
  }

  function updateRing() {
    const el = document.getElementById("ringProgress");
    if (!el) return;
    const p = currentPreset();
    if (!p) return;
    const total = phaseDurationSec(p, state.phaseIndex);
    const frac = total > 0 ? 1 - state.remainingSec / total : 0;
    const off = RING_LEN * (1 - Math.min(1, Math.max(0, frac)));
    el.style.strokeDashoffset = String(off);
  }

  function updateLabels() {
    const p = currentPreset();
    const phase = document.getElementById("phaseLabel");
    const hint = document.getElementById("cycleHint");
    if (!p || !phase || !hint) return;
    const k = phaseKind(state.phaseIndex);
    if (k === "work") {
      const n = workBlockNumber(state.phaseIndex);
      phase.textContent = "Deep work";
      hint.textContent = `Block ${n} of 4 · ${p.name}`;
    } else if (k === "short") {
      phase.textContent = "Short rest";
      hint.textContent = `${p.name} · breathe and reset`;
    } else {
      phase.textContent = "Long rest";
      hint.textContent = `${p.name} · cycle complete`;
    }
  }

  function updateButtons() {
    const primary = document.getElementById("btnPrimary");
    const pauseBtn = document.getElementById("btnPause");
    if (!primary || !pauseBtn) return;
    if (state.running) {
      primary.disabled = true;
      primary.textContent = "In motion";
      pauseBtn.disabled = false;
    } else {
      primary.disabled = false;
      pauseBtn.disabled = true;
      const p = currentPreset();
      const full = p ? phaseDurationSec(p, state.phaseIndex) : 0;
      const atFull = full > 0 && Math.abs(state.remainingSec - full) < 0.75;
      primary.textContent = atFull ? "Start" : "Resume";
    }
  }

  function updateDocumentTitle() {
    if (window.__PAGE__ !== "home") {
      document.title = baseTitle;
      return;
    }
    const suffix = phaseKind(state.phaseIndex) === "work" ? "focus" : "rest";
    document.title = `${formatTime(state.remainingSec)} ${suffix} · Muhurat`;
  }

  function advancePhase() {
    state.phaseIndex = (state.phaseIndex + 1) % 8;
    const p = currentPreset();
    if (!p) return;
    state.remainingSec = phaseDurationSec(p, state.phaseIndex);
    state.lastMinuteBucket = Math.floor(state.remainingSec / 60);
  }

  function onPhaseComplete() {
    const p = currentPreset();
    if (!p) return;
    const endedKind = phaseKind(state.phaseIndex);

    if (endedKind === "work") {
      playWorkCompleteChime();
      notify("Focus block complete", `${p.name} · take your rest.`);
    } else {
      playBreakCompleteChime();
      if (endedKind === "long") {
        notify("Long rest", "Cycle complete. Ready when you are.");
      } else {
        notify("Break complete", "Return to work with intention.");
      }
    }

    advancePhase();
    applyBodyPhaseClass();
    updateLabels();
    updateRing();
    updateDocumentTitle();

    const nextKind = phaseKind(state.phaseIndex);
    const autoNext =
      nextKind === "work"
        ? !!state.settings.auto_start_work
        : !!state.settings.auto_start_break;

    if (autoNext) {
      state.running = true;
      armPhaseEnd();
      startTicking();
    } else {
      state.running = false;
      disarmPhaseEnd();
      stopTicking();
    }

    const td = document.getElementById("timeDisplay");
    if (td) td.textContent = formatTime(state.remainingSec);
    updateButtons();
    updateDocumentTitle();
  }

  function tick() {
    if (!state.running) return;
    syncRemainingFromClock();

    const bucket = Math.floor(state.remainingSec / 60);
    if (
      state.lastMinuteBucket !== null &&
      bucket < state.lastMinuteBucket &&
      state.remainingSec > 0.25
    ) {
      playMinutePulse();
    }
    state.lastMinuteBucket = bucket;

    if (state.remainingSec <= 0) {
      state.remainingSec = 0;
      onPhaseComplete();
      return;
    }

    const td = document.getElementById("timeDisplay");
    if (td) td.textContent = formatTime(state.remainingSec);
    updateRing();
    updateDocumentTitle();
  }

  function startTicking() {
    stopTicking();
    tickTimer = setInterval(tick, 250);
  }

  function stopTicking() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function pause() {
    syncRemainingFromClock();
    state.running = false;
    disarmPhaseEnd();
    stopTicking();
    updateButtons();
    const td = document.getElementById("timeDisplay");
    if (td) td.textContent = formatTime(state.remainingSec);
    updateRing();
    updateDocumentTitle();
  }

  function resume() {
    const p = currentPreset();
    if (!p) return;
    primeAudio();
    requestNotifyPermission();
    if (state.remainingSec <= 0) {
      state.remainingSec = phaseDurationSec(p, state.phaseIndex);
    }
    state.running = true;
    armPhaseEnd();
    state.lastMinuteBucket = Math.floor(state.remainingSec / 60);
    startTicking();
    updateButtons();
    updateDocumentTitle();
  }

  function hardReset() {
    pause();
    state.phaseIndex = 0;
    const p = currentPreset();
    if (p) {
      state.remainingSec = phaseDurationSec(p, 0);
      state.lastMinuteBucket = Math.floor(state.remainingSec / 60);
    }
    applyBodyPhaseClass();
    updateLabels();
    const td = document.getElementById("timeDisplay");
    if (td) td.textContent = formatTime(state.remainingSec);
    updateRing();
    updateButtons();
    updateDocumentTitle();
  }

  function skipPhase() {
    pause();
    advancePhase();
    const td = document.getElementById("timeDisplay");
    if (td) td.textContent = formatTime(state.remainingSec);
    applyBodyPhaseClass();
    updateLabels();
    updateRing();
    updateButtons();
    updateDocumentTitle();
  }

  function selectPreset(id) {
    if (!presetById(id)) return;
    state.presetId = id;
    document.querySelectorAll(".preset-card").forEach((c) => {
      c.classList.toggle("is-active", c.getAttribute("data-id") === id);
    });
    hardReset();
  }

  function renderPresetCards() {
    const host = document.getElementById("presetList");
    if (!host) return;
    host.innerHTML = "";
    state.presets.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "preset-card";
      btn.setAttribute("data-id", p.id);
      const kind = p.kind === "builtin" ? "Built-in" : "Yours";
      const ratio = p.focus_ratio_pct != null ? `${p.focus_ratio_pct}% focus` : "";
      btn.innerHTML = `
        <div class="preset-kind">${kind}</div>
        <div class="preset-name">${escapeHtml(p.name)}</div>
        <div class="preset-sub">${escapeHtml(p.subtitle || "")}</div>
        <div class="preset-meta">${p.work_min} · ${p.short_rest_min} · ${p.long_rest_min} min<br/>${p.cycle_min != null ? `${p.cycle_min} min cycle` : ""}${ratio ? ` · ${ratio}` : ""}${p.muhurat_note ? `<span class="preset-vedic">${escapeHtml(p.muhurat_note)}</span>` : ""}</div>
      `;
      btn.addEventListener("click", () => selectPreset(p.id));
      host.appendChild(btn);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function wireControls() {
    const primary = document.getElementById("btnPrimary");
    const pauseBtn = document.getElementById("btnPause");
    const skip = document.getElementById("btnSkip");
    const reset = document.getElementById("btnReset");
    if (primary) {
      primary.addEventListener("click", () => {
        if (state.running) return;
        requestNotifyPermission();
        resume();
      });
    }
    if (pauseBtn) {
      pauseBtn.addEventListener("click", () => {
        if (state.running) pause();
      });
    }
    if (skip) skip.addEventListener("click", () => skipPhase());
    if (reset) reset.addEventListener("click", () => hardReset());
  }

  async function init() {
    if (window.__PAGE__ !== "home") return;
    wireControls();
    try {
      const [presetRes, settings] = await Promise.all([
        api("/api/presets"),
        api("/api/settings"),
      ]);
      state.settings = settings;
      state.presets = [...presetRes.builtins, ...presetRes.custom];
      const def = settings.default_preset_id;
      state.presetId = presetById(def) ? def : state.presets[0]?.id;
      renderPresetCards();
      selectPreset(state.presetId);
    } catch (e) {
      console.error(e);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.running) {
      syncRemainingFromClock();
      const td = document.getElementById("timeDisplay");
      if (td) td.textContent = formatTime(state.remainingSec);
      updateRing();
      updateDocumentTitle();
    }
  });

  document.addEventListener("DOMContentLoaded", init);
})();
