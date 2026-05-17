(function () {
  "use strict";

  const RING_LEN = 2 * Math.PI * 96;
  const baseTitle = document.title;
  const SESSION_STORAGE_KEY = "muhurat_timer_session_v1";

  /** @type {ReturnType<typeof setInterval> | null} */
  let tickTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let statsTimer = null;
  /** @type {number | null} */
  let phaseEndsAt = null;

  const state = {
    presets: [],
    settings: {},
    presetId: null,
    phaseIndex: 0,
    remainingSec: 0,
    running: false,
    lastMinuteBucket: null,
    /** idle | work | extend | rest | cumulative | work_choice | rest_choice | complete */
    mode: "idle",
    pendingRest: null,
    afterRestWorkIndex: null,
    resumeAfterPoolRest: null,
    restartAfterLevelChange: false,
    session: {
      active: false,
      startedAt: null,
      workSec: 0,
      extendSec: 0,
      restTakenSec: 0,
      poolSec: 0,
      extendPoolAccrued: 0,
      segStartedAt: null,
      segKind: null,
      segDurationSec: 0,
    },
  };

  function restAccrualRate(p) {
    const workSec = 4 * p.work_min * 60;
    const restSec = 3 * p.short_rest_min * 60 + p.long_rest_min * 60;
    return workSec > 0 ? restSec / workSec : 0;
  }

  function syncExtendPoolAccrual() {
    if (state.mode !== "extend") return;
    const p = currentPreset();
    if (!p) return;
    const rate = restAccrualRate(p);
    const extTotal = state.session.extendSec + liveSegmentElapsed();
    const target = extTotal * rate;
    const prev = state.session.extendPoolAccrued || 0;
    const delta = target - prev;
    if (delta > 0.001) {
      state.session.extendPoolAccrued = target;
      state.session.poolSec += delta;
    }
  }

  function persistSession() {
    if (window.__PAGE__ !== "home") return;
    if (!state.session.active && state.mode === "idle") {
      try {
        sessionStorage.removeItem(SESSION_STORAGE_KEY);
      } catch (_) {}
      return;
    }
    try {
      const payload = {
        presetId: state.presetId,
        phaseIndex: state.phaseIndex,
        remainingSec: state.remainingSec,
        running: state.running,
        mode: state.mode,
        pendingRest: state.pendingRest,
        afterRestWorkIndex: state.afterRestWorkIndex,
        resumeAfterPoolRest: state.resumeAfterPoolRest,
        lastMinuteBucket: state.lastMinuteBucket,
        phaseEndsAt,
        session: {
          active: state.session.active,
          startedAt: state.session.startedAt,
          workSec: state.session.workSec,
          extendSec: state.session.extendSec,
          restTakenSec: state.session.restTakenSec,
          poolSec: state.session.poolSec,
          extendPoolAccrued: state.session.extendPoolAccrued,
          segKind: state.session.segKind,
          segDurationSec: state.session.segDurationSec,
          segStartedAt: state.session.segStartedAt,
        },
        savedAt: Date.now(),
      };
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(payload));
    } catch (_) {}
  }

  function restoreSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data?.session?.active || !presetById(data.presetId)) return false;

      state.presetId = data.presetId;
      state.phaseIndex = data.phaseIndex ?? 0;
      state.mode = data.mode ?? "idle";
      state.pendingRest = data.pendingRest ?? null;
      state.afterRestWorkIndex = data.afterRestWorkIndex ?? null;
      state.resumeAfterPoolRest = data.resumeAfterPoolRest ?? null;
      state.lastMinuteBucket = data.lastMinuteBucket ?? null;
      state.session = {
        active: true,
        startedAt: data.session.startedAt,
        workSec: data.session.workSec ?? 0,
        extendSec: data.session.extendSec ?? 0,
        restTakenSec: data.session.restTakenSec ?? 0,
        poolSec: data.session.poolSec ?? 0,
        extendPoolAccrued: data.session.extendPoolAccrued ?? 0,
        segKind: data.session.segKind,
        segDurationSec: data.session.segDurationSec ?? 0,
        segStartedAt: data.session.segStartedAt,
      };

      if (data.running && data.phaseEndsAt) {
        const left = (data.phaseEndsAt - Date.now()) / 1000;
        if (left <= 0 && ["work", "rest", "cumulative"].includes(state.mode)) {
          state.remainingSec = 0;
          state.running = false;
          phaseEndsAt = null;
        } else {
          state.remainingSec = left;
          state.running = true;
          phaseEndsAt = data.phaseEndsAt;
        }
      } else {
        state.remainingSec = data.remainingSec ?? 0;
        state.running = false;
        phaseEndsAt = null;
      }

      syncLevelSelect();

      if (state.session.segStartedAt && state.session.segKind) {
        const pausedMs = Date.now() - data.savedAt;
        if (!state.running && pausedMs > 0) {
          state.session.segStartedAt += pausedMs;
        }
      }

      ensureStatsLoop();
      applyBodyPhaseClass();
      updateAll();

      if (state.running) startTicking();
      else if (state.mode === "extend") syncExtendPoolAccrual();

      if (state.remainingSec <= 0 && ["work", "rest", "cumulative"].includes(state.mode)) {
        setTimeout(() => onTimerElapsed(), 50);
      } else if (state.mode === "work_choice" && state.pendingRest) {
        showWorkChoices(true);
      } else if (state.mode === "rest_choice") {
        showRestChoices(true);
      } else if (state.mode === "complete") {
        showCycleComplete(true);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  function setupIdleTimer() {
    const p = currentPreset();
    if (!p) return;
    state.phaseIndex = 0;
    state.mode = "idle";
    state.remainingSec = phaseDurationSec(p, 0);
    state.running = false;
    state.pendingRest = null;
    state.afterRestWorkIndex = null;
    state.resumeAfterPoolRest = null;
    disarmPhaseEnd();
    applyBodyPhaseClass();
    updateAll();
  }

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

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function presetById(id) {
    return state.presets.find((p) => p.id === id) || null;
  }

  function currentPreset() {
    return presetById(state.presetId);
  }

  function phaseKind(i) {
    const p = currentPreset();
    if (p && i === lastRestIndex(p)) return "long";
    if (i % 2 === 0) return "work";
    return "short";
  }

  function workCycleCount(p) {
    return Math.max(1, Number(p?.work_cycles || 4));
  }

  function lastWorkIndex(p) {
    return (workCycleCount(p) - 1) * 2;
  }

  function lastRestIndex(p) {
    return lastWorkIndex(p) + 1;
  }

  function isFinalWorkIndex(i) {
    const p = currentPreset();
    return !!p && i === lastWorkIndex(p);
  }

  function isFinalRestIndex(i) {
    const p = currentPreset();
    return !!p && i === lastRestIndex(p);
  }

  function phaseDurationSec(p, i) {
    const k = phaseKind(i);
    if (k === "work") return p.work_min * 60;
    if (k === "short") return p.short_rest_min * 60;
    return p.long_rest_min * 60;
  }

  function restIndexAfterWork(workIndex) {
    return workIndex + 1;
  }

  function workIndexAfterRest(restIndex) {
    const p = currentPreset();
    const next = restIndex + 1;
    return p && next <= lastWorkIndex(p) ? next : 0;
  }

  function workIndexAfterSkipRest(workIndex) {
    const p = currentPreset();
    const next = workIndex + 2;
    return p && next <= lastWorkIndex(p) ? next : 0;
  }

  function workBlockNumber(i) {
    if (phaseKind(i) !== "work") return null;
    return i / 2 + 1;
  }

  function formatClock(sec) {
    const s = Math.max(0, Math.ceil(sec));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }

  function formatPool(sec) {
    const s = Math.max(0, Math.round(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
    return `${m}:${String(r).padStart(2, "0")}`;
  }

  function restLabel(kind) {
    return kind === "long" ? "long rest" : "short rest";
  }

  function playWorkCompleteChime() {
    window.FocusSounds?.workComplete(state.settings);
  }

  function playBreakCompleteChime() {
    window.FocusSounds?.breakComplete(state.settings);
  }

  function playMinutePulse() {
    window.FocusSounds?.tick(state.settings);
  }

  function playChoiceChime() {
    window.FocusSounds?.choice(state.settings);
  }

  function playPoolChime() {
    window.FocusSounds?.poolAdd(state.settings);
  }

  function playSkipChime() {
    window.FocusSounds?.skip(state.settings);
  }

  function primeAudio() {
    window.FocusSounds?.prime(state.settings);
  }

  async function requestNotifyPermission() {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") await Notification.requestPermission();
  }

  function notify(title, body) {
    if (!state.settings.notifications_enabled) return;
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    if (document.visibilityState === "visible") return;
    try {
      new Notification(title, { body, silent: true });
    } catch (_) {}
  }

  function logWorkBlock(minutes) {
    return api("/api/focus/log", {
      method: "POST",
      body: JSON.stringify({ day: todayISO(), minutes }),
    }).catch(() => {});
  }

  function ensureSession() {
    const s = state.session;
    if (!s.active) {
      s.active = true;
      s.startedAt = Date.now();
    }
    ensureStatsLoop();
  }

  function ensureStatsLoop() {
    if (statsTimer) return;
    statsTimer = setInterval(() => {
      if (!state.session.active) {
        if (statsTimer) clearInterval(statsTimer);
        statsTimer = null;
        return;
      }
      renderLiveStats();
      if (state.mode === "extend") persistSession();
    }, 200);
  }

  function stopStatsLoop() {
    if (statsTimer) {
      clearInterval(statsTimer);
      statsTimer = null;
    }
  }

  function commitSegment() {
    const s = state.session;
    if (!s.segStartedAt || !s.segKind) return;
    if (s.segKind === "extend") syncExtendPoolAccrual();
    const elapsed = (Date.now() - s.segStartedAt) / 1000;
    if (s.segKind === "work") s.workSec += elapsed;
    else if (s.segKind === "extend") s.extendSec += elapsed;
    else if (s.segKind === "rest" || s.segKind === "cumulative") s.restTakenSec += elapsed;
    s.segStartedAt = null;
    s.segKind = null;
    s.segDurationSec = 0;
    persistSession();
  }

  function startSegment(kind, durationSec) {
    const s = state.session;
    s.segKind = kind;
    s.segStartedAt = Date.now();
    s.segDurationSec = durationSec || 0;
  }

  function liveSegmentElapsed() {
    const s = state.session;
    if (!s.segStartedAt || !s.segKind) return 0;
    return (Date.now() - s.segStartedAt) / 1000;
  }

  function liveWorkSec() {
    const s = state.session;
    let w = s.workSec + s.extendSec;
    const k = s.segKind;
    if (k === "work" || k === "extend") w += liveSegmentElapsed();
    return w;
  }

  function sessionElapsedSec() {
    const s = state.session;
    if (!s.active || !s.startedAt) return 0;
    return (Date.now() - s.startedAt) / 1000;
  }

  function productivityPct() {
    const elapsed = sessionElapsedSec();
    if (elapsed < 0.5) return null;
    return Math.min(100, (liveWorkSec() / elapsed) * 100);
  }

  function addToPool(sec, chime) {
    const add = Math.max(0, sec);
    if (add <= 0) return;
    state.session.poolSec += add;
    if (chime !== false) playPoolChime();
    renderLiveStats();
    persistSession();
  }

  function renderLiveStats() {
    if (state.mode === "extend") syncExtendPoolAccrual();
    const poolEl = document.getElementById("poolDisplay");
    const prodEl = document.getElementById("productivityDisplay");
    if (poolEl) poolEl.textContent = formatPool(state.session.poolSec);
    if (prodEl) {
      const p = productivityPct();
      prodEl.textContent = p === null ? "—" : `${p.toFixed(1)}%`;
    }
    updateControlVisibility();
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

  function applyBodyPhaseClass() {
    document.body.classList.remove(
      "rest-short",
      "rest-long",
      "focus-work",
      "mode-extend",
      "mode-choice",
      "mode-cumulative",
      "mode-complete"
    );
    if (state.mode === "complete") {
      document.body.classList.add("mode-choice", "mode-complete");
      return;
    }
    if (state.mode === "work_choice" || state.mode === "rest_choice") {
      document.body.classList.add("mode-choice");
      return;
    }
    if (state.mode === "extend") {
      document.body.classList.add("focus-work", "mode-extend");
      return;
    }
    if (state.mode === "cumulative") {
      document.body.classList.add("rest-short", "mode-cumulative");
      return;
    }
    const k =
      state.mode === "rest"
        ? state.pendingRest?.kind || phaseKind(state.phaseIndex)
        : phaseKind(state.phaseIndex);
    if (k === "short" || (state.mode === "rest" && state.pendingRest?.kind === "short"))
      document.body.classList.add("rest-short");
    else if (k === "long") document.body.classList.add("rest-long");
    else if (state.mode === "work" || state.mode === "idle") document.body.classList.add("focus-work");
  }

  function updateRing() {
    const el = document.getElementById("ringProgress");
    const wrap = document.querySelector(".timer-ring-wrap");
    if (!el) return;
    if (state.mode === "extend") {
      el.style.strokeDashoffset = "0";
      wrap?.classList.add("ring-extend");
      return;
    }
    wrap?.classList.remove("ring-extend");
    if (state.mode === "work_choice" || state.mode === "rest_choice") {
      el.style.strokeDashoffset = String(RING_LEN);
      return;
    }
    const p = currentPreset();
    if (!p) return;
    let total = state.remainingSec;
    if (state.mode === "work" || state.mode === "rest" || state.mode === "cumulative") {
      total = state.session.segDurationSec || phaseDurationSec(p, state.phaseIndex);
    }
    const frac = total > 0 ? 1 - state.remainingSec / total : 0;
    el.style.strokeDashoffset = String(RING_LEN * (1 - Math.min(1, Math.max(0, frac))));
  }

  function updateLabels() {
    const p = currentPreset();
    const phase = document.getElementById("phaseLabel");
    const hint = document.getElementById("cycleHint");
    if (!p || !phase || !hint) return;

    if (state.mode === "extend") {
      phase.textContent = "Extended focus";
      hint.textContent = "";
      hint.classList.add("hidden");
      return;
    }
    hint.classList.remove("hidden");
    if (state.mode === "complete") {
      phase.textContent = "Complete";
      hint.textContent = `${p.name} finished`;
      return;
    }
    if (state.mode === "work_choice") {
      phase.textContent = "Block complete";
      hint.textContent = `Block ${workBlockNumber(state.phaseIndex) || ""} of ${workCycleCount(p)}`;
      return;
    }
    if (state.mode === "rest_choice") {
      phase.textContent = "Rest complete";
      const pool = formatPool(state.session.poolSec);
      hint.textContent = state.session.poolSec >= 1 ? `${pool} in pool` : "Pool empty";
      return;
    }
    if (state.mode === "cumulative") {
      phase.textContent = "Cumulative rest";
      hint.textContent = "Deferred time, taken together";
      return;
    }

    const k = state.mode === "rest" ? state.pendingRest?.kind || phaseKind(state.phaseIndex) : phaseKind(state.phaseIndex);
    if (k === "work" || state.mode === "work") {
      const n = workBlockNumber(state.phaseIndex);
      phase.textContent = "Deep work";
      hint.textContent = `Block ${n} of ${workCycleCount(p)} · ${p.name}`;
    } else if (k === "short") {
      phase.textContent = "Short rest";
      hint.textContent = `${p.name} · breathe`;
    } else {
      phase.textContent = "Long rest";
      hint.textContent = `${p.name} · cycle pause`;
    }
  }

  function updateTimeDisplay() {
    const td = document.getElementById("timeDisplay");
    if (!td) return;
    if (state.mode === "extend") {
      td.textContent = `+${formatClock(liveSegmentElapsed())}`;
      td.classList.add("time-extend");
      return;
    }
    td.classList.remove("time-extend");
    td.textContent = formatClock(state.remainingSec);
  }

  function updateDocumentTitle() {
    if (window.__PAGE__ !== "home") {
      document.title = baseTitle;
      return;
    }
    if (state.mode === "extend") {
      document.title = `+${formatClock(liveSegmentElapsed())} extend · Muhurat`;
      return;
    }
    if (state.mode === "work_choice" || state.mode === "rest_choice") {
      document.title = `Choose · Muhurat`;
      return;
    }
    if (state.mode === "complete") {
      document.title = `Complete · Muhurat`;
      return;
    }
    const suffix =
      state.mode === "work" || state.mode === "idle" ? "focus" : "rest";
    document.title = `${formatClock(state.remainingSec)} ${suffix} · Muhurat`;
  }

  function setChoicePanel(visible, prompt, actions) {
    const panel = document.getElementById("choicePanel");
    const promptEl = document.getElementById("choicePrompt");
    const actionsEl = document.getElementById("choiceActions");
    const mainControls = document.getElementById("mainControls");
    if (!panel || !promptEl || !actionsEl) return;
    panel.classList.toggle("hidden", !visible);
    mainControls?.classList.toggle("hidden", visible);
    if (!visible) {
      actionsEl.innerHTML = "";
      return;
    }
    promptEl.textContent = prompt;
    actionsEl.innerHTML = "";
    actions.forEach(({ label, primary, onClick, disabled }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = primary ? "btn btn-primary" : "btn btn-quiet";
      btn.textContent = label;
      btn.disabled = !!disabled;
      if (!disabled) {
        btn.addEventListener("click", () => {
          hideChoices();
          onClick();
        });
      }
      actionsEl.appendChild(btn);
    });
  }

  function hideChoices() {
    setChoicePanel(false, "", []);
    document.getElementById("mainControls")?.classList.remove("hidden");
  }

  function showWorkChoices(silent) {
    state.running = false;
    disarmPhaseEnd();
    stopTicking();
    state.mode = "work_choice";
    const pr = state.pendingRest;
    const label = pr ? restLabel(pr.kind) : "rest";
    const dur = pr ? formatClock(pr.sec) : "";
    if (!silent) playChoiceChime();
    setChoicePanel(true, `Focus block complete · ${dur} ${label} is due`, [
      { label: "Start rest (1)", primary: true, onClick: () => chooseStartRest() },
      { label: "Extend focus (2)", primary: false, onClick: () => chooseExtendFocus() },
      { label: "Skip rest (3)", primary: false, onClick: () => chooseSkipRest() },
    ]);
    applyBodyPhaseClass();
    updateLabels();
    updateRing();
    updateTimeDisplay();
    updateControlVisibility();
    renderLiveStats();
  }

  function showRestChoices(silent) {
    state.running = false;
    disarmPhaseEnd();
    stopTicking();
    state.mode = "rest_choice";
    const pool = state.session.poolSec;
    const poolLabel = formatPool(pool);
    if (!silent) playChoiceChime();
    const actions = [
      { label: "Start next focus (1)", primary: true, onClick: () => chooseStartNextFocus() },
    ];
    if (pool >= 1) {
      actions.push({
        label: `Take cumulative rest (2) · ${poolLabel}`,
        primary: false,
        onClick: () => chooseCumulativeRest(),
      });
    }
    const msg =
      pool >= 1
        ? `Rest complete · ${poolLabel} waiting in your pool`
        : "Rest complete";
    setChoicePanel(true, msg, actions);
    applyBodyPhaseClass();
    updateLabels();
    updateRing();
    updateTimeDisplay();
    updateControlVisibility();
    renderLiveStats();
  }

  function showCycleComplete(silent) {
    const p = currentPreset();
    state.running = false;
    disarmPhaseEnd();
    stopTicking();
    state.mode = "complete";
    state.pendingRest = null;
    state.afterRestWorkIndex = null;
    state.resumeAfterPoolRest = null;
    if (!silent) {
      playChoiceChime();
      notify("Cycle complete", p ? `${p.name} complete.` : "Session complete.");
    }
    setChoicePanel(true, p ? `${p.name} complete` : "Cycle complete", [
      { label: "Done", primary: false, onClick: () => resetSession() },
      { label: "Restart", primary: true, onClick: () => restartCurrentLevel() },
      { label: "Change level and restart", primary: false, onClick: () => chooseLevelAndRestart() },
    ]);
    applyBodyPhaseClass();
    updateLabels();
    updateRing();
    updateTimeDisplay();
    updateControlVisibility();
    renderLiveStats();
    persistSession();
  }

  function buildPendingRest(workIndex) {
    const p = currentPreset();
    if (!p) return null;
    const ri = restIndexAfterWork(workIndex);
    const kind = phaseKind(ri);
    return { sec: phaseDurationSec(p, ri), kind, restIndex: ri, workIndex };
  }

  function onWorkBlockComplete(fromEarlyEnd) {
    const p = currentPreset();
    if (!p) return;
    ensureSession();
    commitSegment();
    playWorkCompleteChime();
    notify("Focus block complete", `${p.name} · choose your next step.`);
    logWorkBlock(p.work_min);

    state.pendingRest = buildPendingRest(state.phaseIndex);
    showWorkChoices();
  }

  function onRestComplete() {
    const p = currentPreset();
    if (!p) return;
    commitSegment();
    playBreakCompleteChime();
    if (state.resumeAfterPoolRest) {
      resumeInterruptedFocus();
      return;
    }
    notify("Rest complete", "Choose your next step.");

    if (state.mode !== "cumulative" && state.pendingRest) {
      state.afterRestWorkIndex = workIndexAfterRest(state.pendingRest.restIndex);
    }

    state.pendingRest = null;
    if (isFinalRestIndex(state.phaseIndex)) {
      showCycleComplete();
      return;
    }
    showRestChoices();
  }

  function chooseStartRest() {
    const pr = state.pendingRest;
    if (!pr) return;
    ensureSession();
    state.phaseIndex = pr.restIndex;
    state.mode = "rest";
    state.remainingSec = pr.sec;
    state.pendingRest = { ...pr };
    startSegment("rest", pr.sec);
    startCountdown(true);
    applyBodyPhaseClass();
  }

  function chooseExtendFocus() {
    const pr = state.pendingRest;
    if (!pr) return;
    ensureSession();
    state.mode = "extend";
    state.running = true;
    disarmPhaseEnd();
    startSegment("extend", 0);
    startTicking();
    updateAll();
    persistSession();
  }

  function chooseSkipRest() {
    const pr = state.pendingRest;
    if (!pr) return;
    addToPool(pr.sec);
    playSkipChime();
    state.pendingRest = null;
    if (isFinalWorkIndex(pr.workIndex)) {
      showCycleComplete();
      return;
    }
    state.phaseIndex = workIndexAfterSkipRest(pr.workIndex);
    beginWork(true);
  }

  function skipRestFromExtend() {
    if (state.mode !== "extend") return;
    syncExtendPoolAccrual();
    commitSegment();
    const pr = state.pendingRest;
    if (!pr) return;
    addToPool(pr.sec, false);
    playSkipChime();
    state.pendingRest = null;
    if (isFinalWorkIndex(pr.workIndex)) {
      showCycleComplete();
      return;
    }
    state.phaseIndex = workIndexAfterSkipRest(pr.workIndex);
    beginWork(true);
  }

  function chooseStartNextFocus() {
    const wi = state.afterRestWorkIndex;
    if (wi == null) return;
    state.phaseIndex = wi;
    state.afterRestWorkIndex = null;
    beginWork(true);
  }

  function chooseCumulativeRest() {
    const pool = state.session.poolSec;
    if (pool < 1) return;
    ensureSession();
    state.session.poolSec = 0;
    renderLiveStats();
    state.mode = "cumulative";
    state.remainingSec = pool;
    startSegment("cumulative", pool);
    startCountdown(true);
  }

  function takePoolRestNow() {
    const pool = state.session.poolSec;
    if (pool < 1 || state.mode === "cumulative" || state.mode === "complete") return;
    if (state.mode === "work_choice" || state.mode === "rest_choice") return;
    if (state.mode === "rest") return;

    syncRemainingFromClock();
    if (state.session.segStartedAt) commitSegment();
    state.resumeAfterPoolRest = {
      mode: state.mode,
      phaseIndex: state.phaseIndex,
      remainingSec: state.remainingSec,
      pendingRest: state.pendingRest ? { ...state.pendingRest } : null,
      afterRestWorkIndex: state.afterRestWorkIndex,
    };
    state.session.poolSec = 0;
    state.mode = "cumulative";
    state.running = true;
    state.remainingSec = pool;
    startSegment("cumulative", pool);
    startCountdown(true);
    applyBodyPhaseClass();
  }

  function resumeInterruptedFocus() {
    const saved = state.resumeAfterPoolRest;
    state.resumeAfterPoolRest = null;
    if (!saved || saved.mode === "idle") {
      setupIdleTimer();
      return;
    }
    state.mode = saved.mode;
    state.phaseIndex = saved.phaseIndex;
    state.remainingSec = saved.remainingSec;
    state.pendingRest = saved.pendingRest;
    state.afterRestWorkIndex = saved.afterRestWorkIndex;
    if (state.mode === "extend") {
      state.running = true;
      startSegment("extend", 0);
      startTicking();
      updateAll();
      return;
    }
    if (state.mode === "work") {
      startSegment("work", state.remainingSec);
      startCountdown(true);
      applyBodyPhaseClass();
      return;
    }
    setupIdleTimer();
  }

  function restartCurrentLevel() {
    resetSession();
    beginWork(true);
  }

  function chooseLevelAndRestart() {
    state.restartAfterLevelChange = true;
    setChoicePanel(true, "Choose a level", [
      { label: "Done", primary: false, onClick: () => resetSession() },
    ]);
    toggleLevelMenu();
    document.getElementById("levelButton")?.focus();
  }

  function beginRestFromExtend() {
    syncExtendPoolAccrual();
    commitSegment();
    const pr = state.pendingRest;
    if (!pr) return;
    state.mode = "rest";
    state.phaseIndex = pr.restIndex;
    state.remainingSec = pr.sec;
    state.pendingRest = { ...pr };
    startSegment("rest", pr.sec);
    startCountdown(true);
    applyBodyPhaseClass();
  }

  function beginWork(autoRun) {
    const p = currentPreset();
    if (!p) return;
    ensureSession();
    state.mode = "work";
    state.remainingSec = phaseDurationSec(p, state.phaseIndex);
    state.pendingRest = null;
    startSegment("work", state.remainingSec);
    if (autoRun) {
      if (liveWorkSec() < 0.5) window.FocusSounds?.start(state.settings);
      startCountdown(true);
    }
    else {
      state.running = false;
      disarmPhaseEnd();
      updateAll();
    }
  }

  function startCountdown(run) {
    state.running = run;
    if (run) {
      armPhaseEnd();
      state.lastMinuteBucket = Math.floor(state.remainingSec / 60);
      startTicking();
    } else {
      disarmPhaseEnd();
      stopTicking();
    }
    updateControlVisibility();
    updateAll();
  }

  function pauseTimer() {
    if (state.running) {
      syncRemainingFromClock();
      commitSegment();
    }
    state.running = false;
    disarmPhaseEnd();
    stopTicking();
    updateControlVisibility();
    updateAll();
  }

  function resumeTimer() {
    requestNotifyPermission();
    primeAudio();
    if (state.mode === "extend") {
      if (!state.session.segStartedAt) startSegment("extend", 0);
      state.running = true;
      startTicking();
    } else if (state.mode === "work" || state.mode === "rest" || state.mode === "cumulative") {
      if (!state.session.segStartedAt) {
        const kind =
          state.mode === "work" ? "work" : state.mode === "cumulative" ? "cumulative" : "rest";
        startSegment(kind, state.remainingSec);
      }
      if (state.remainingSec <= 0) {
        const p = currentPreset();
        if (p && state.mode === "work")
          state.remainingSec = phaseDurationSec(p, state.phaseIndex);
      }
      startCountdown(true);
    } else if (state.mode === "idle") {
      beginWork(true);
    }
    updateControlVisibility();
    updateAll();
  }

  function skipRemainingRest() {
    if (state.mode !== "rest" && state.mode !== "cumulative") return;
    syncRemainingFromClock();
    commitSegment();
    addToPool(state.remainingSec);
    playSkipChime();
    state.remainingSec = 0;
    disarmPhaseEnd();
    stopTicking();

    if (state.resumeAfterPoolRest) {
      resumeInterruptedFocus();
      return;
    }

    let nextWork;
    if (state.mode === "cumulative") {
      nextWork = state.afterRestWorkIndex ?? 0;
    } else if (state.pendingRest) {
      nextWork = workIndexAfterRest(state.pendingRest.restIndex);
    } else {
      nextWork = workIndexAfterRest(state.phaseIndex);
    }
    state.pendingRest = null;
    state.phaseIndex = nextWork;
    beginWork(true);
  }

  function onTimerElapsed() {
    state.running = false;
    disarmPhaseEnd();
    stopTicking();
    if (state.mode === "work") {
      state.remainingSec = 0;
      onWorkBlockComplete(false);
    } else if (state.mode === "rest" || state.mode === "cumulative") {
      state.remainingSec = 0;
      onRestComplete();
    }
  }

  function tick() {
    renderLiveStats();

    if (state.mode === "extend" && state.running) {
      updateTimeDisplay();
      updateRing();
      updateDocumentTitle();
      updateLabels();
      return;
    }

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
      onTimerElapsed();
      return;
    }

    updateTimeDisplay();
    updateRing();
    updateDocumentTitle();
  }

  function startTicking() {
    stopTicking();
    tickTimer = setInterval(tick, 250);
    tick();
  }

  function stopTicking() {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  function updateControlVisibility() {
    const primary = document.getElementById("btnPrimary");
    const takeRest = document.getElementById("btnTakePoolRest");
    const skipRem = document.getElementById("btnSkipRemaining");
    const beginRest = document.getElementById("btnBeginRest");
    const skipExtend = document.getElementById("btnSkipRestExtend");
    const inChoice = state.mode === "work_choice" || state.mode === "rest_choice" || state.mode === "complete";
    const inRest = state.mode === "rest" || state.mode === "cumulative";
    const inExtend = state.mode === "extend";

    if (skipRem) {
      skipRem.classList.toggle("hidden", inChoice || !inRest);
      skipRem.textContent = "Skip remaining";
      skipRem.title = "Bank remaining rest to the pool and start next focus";
    }
    if (takeRest) {
      const canTake = state.session.poolSec >= 1 && !inChoice && !inRest && state.mode !== "complete";
      takeRest.classList.toggle("hidden", !canTake);
      takeRest.textContent = `Take rest · ${formatPool(state.session.poolSec)}`;
    }
    beginRest?.classList.toggle("hidden", !inExtend || inChoice);
    skipExtend?.classList.toggle("hidden", !inExtend || inChoice);

    if (inChoice) return;

    if (primary) {
      primary.classList.remove("hidden");
      primary.disabled = false;
      if (state.running) {
        primary.textContent = "Pause";
      } else {
        if (state.mode === "idle") primary.textContent = "Start";
        else primary.textContent = "Resume";
      }
    }
  }

  function updateAll() {
    updateLabels();
    updateTimeDisplay();
    updateRing();
    updateDocumentTitle();
    updateControlVisibility();
    renderLiveStats();
    persistSession();
  }

  function resetSession() {
    pauseTimer();
    commitSegment();
    stopTicking();
    stopStatsLoop();
    state.mode = "idle";
    state.phaseIndex = 0;
    state.pendingRest = null;
    state.afterRestWorkIndex = null;
    state.resumeAfterPoolRest = null;
    state.restartAfterLevelChange = false;
    state.session = {
      active: false,
      startedAt: null,
      workSec: 0,
      extendSec: 0,
      restTakenSec: 0,
      poolSec: 0,
      extendPoolAccrued: 0,
      segStartedAt: null,
      segKind: null,
      segDurationSec: 0,
    };
    const p = currentPreset();
    if (p) state.remainingSec = phaseDurationSec(p, 0);
    hideChoices();
    try {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } catch (_) {}
    setChoicePanel(false, "", []);
    applyBodyPhaseClass();
    updateAll();
    renderLiveStats();
  }

  function syncLevelSelect() {
    const buttonText = document.getElementById("levelButtonText");
    const button = document.getElementById("levelButton");
    const p = presetById(state.presetId);
    if (buttonText && p) buttonText.textContent = p.name;
    if (button && p) button.setAttribute("aria-label", `Focus level: ${p.name}`);
    document.querySelectorAll(".level-option").forEach((option) => {
      const active = option.getAttribute("data-id") === state.presetId;
      option.classList.toggle("is-active", active);
      option.setAttribute("aria-selected", active ? "true" : "false");
    });
  }

  function closeLevelMenu() {
    const menu = document.getElementById("levelMenu");
    const button = document.getElementById("levelButton");
    menu?.classList.add("hidden");
    button?.setAttribute("aria-expanded", "false");
  }

  function toggleLevelMenu() {
    const menu = document.getElementById("levelMenu");
    const button = document.getElementById("levelButton");
    if (!menu || !button) return;
    const open = menu.classList.toggle("hidden");
    button.setAttribute("aria-expanded", open ? "false" : "true");
  }

  function selectPreset(id, fromUser) {
    if (!presetById(id)) return;
    if (state.presetId === id) return;
    if (state.restartAfterLevelChange) {
      hideChoices();
      state.presetId = id;
      syncLevelSelect();
      closeLevelMenu();
      resetSession();
      beginWork(true);
      return;
    }
    if (
      fromUser &&
      state.session.active &&
      !confirm("Switch level and reset this session? Pool and progress will clear.")
    ) {
      syncLevelSelect();
      closeLevelMenu();
      return;
    }
    state.presetId = id;
    syncLevelSelect();
    closeLevelMenu();
    resetSession();
  }

  function renderLevelSelect() {
    const menu = document.getElementById("levelMenu");
    const button = document.getElementById("levelButton");
    if (!menu || !button) return;
    menu.innerHTML = "";
    state.presets.forEach((p) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "level-option";
      option.setAttribute("role", "option");
      option.setAttribute("data-id", p.id);
      option.innerHTML = `
        <span>
          <span class="level-name">${escapeHtml(p.name)}</span>
          <span class="level-sub">${escapeHtml(p.subtitle || (p.kind === "custom" ? "Custom" : ""))}</span>
        </span>
        <span class="level-meta">${p.work_min} / ${p.short_rest_min} / ${p.long_rest_min} min</span>
      `;
      option.addEventListener("click", () => selectPreset(p.id, true));
      menu.appendChild(option);
    });
    syncLevelSelect();
    if (!button.dataset.wired) {
      button.dataset.wired = "1";
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleLevelMenu();
      });
      document.addEventListener("click", (e) => {
        if (!document.getElementById("levelPicker")?.contains(e.target)) closeLevelMenu();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeLevelMenu();
      });
    }
  }


  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function handleShortcut(e) {
    if (isTypingTarget(e.target)) return;
    const k = e.key.toLowerCase();

    if (state.mode === "work_choice") {
      if (k === "1") {
        e.preventDefault();
        hideChoices();
        chooseStartRest();
      } else if (k === "2") {
        e.preventDefault();
        hideChoices();
        chooseExtendFocus();
      } else if (k === "3") {
        e.preventDefault();
        hideChoices();
        chooseSkipRest();
      }
      return;
    }
    if (state.mode === "rest_choice") {
      if (k === "1") {
        e.preventDefault();
        hideChoices();
        chooseStartNextFocus();
      } else if (k === "2" && state.session.poolSec >= 1) {
        e.preventDefault();
        hideChoices();
        chooseCumulativeRest();
      }
      return;
    }

    if (k === "s") {
      e.preventDefault();
      if (!state.running && !["work_choice", "rest_choice", "complete"].includes(state.mode)) resumeTimer();
      return;
    }
    if (k === "t") {
      e.preventDefault();
      takePoolRestNow();
      return;
    }
    if (k === "r") {
      e.preventDefault();
      if (state.session.active && !confirm("Reset this session? Progress and pool will clear.")) return;
      resetSession();
      return;
    }
    if (k === "k" && (state.mode === "rest" || state.mode === "cumulative")) {
      e.preventDefault();
      skipRemainingRest();
      return;
    }
    if (k === "b" && state.mode === "extend") {
      e.preventDefault();
      beginRestFromExtend();
      return;
    }
    if (k === "3" && state.mode === "extend") {
      e.preventDefault();
      skipRestFromExtend();
    }
  }

  function wireControls() {
    document.getElementById("btnPrimary")?.addEventListener("click", () => {
      if (state.mode === "work_choice" || state.mode === "rest_choice" || state.mode === "complete") return;
      if (state.running) {
        pauseTimer();
        return;
      }
      primeAudio();
      resumeTimer();
    });
    document.getElementById("btnTakePoolRest")?.addEventListener("click", () => takePoolRestNow());
    document.getElementById("btnSkipRemaining")?.addEventListener("click", () => skipRemainingRest());
    document.getElementById("btnBeginRest")?.addEventListener("click", () => beginRestFromExtend());
    document.getElementById("btnSkipRestExtend")?.addEventListener("click", () => skipRestFromExtend());
    document.getElementById("btnReset")?.addEventListener("click", () => {
      if (state.session.active && !confirm("Reset this session? Progress and pool will clear.")) return;
      resetSession();
    });

    document.addEventListener("keydown", handleShortcut);
    document.addEventListener("keyup", (e) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      if (state.running) pauseTimer();
      else if (!["work_choice", "rest_choice", "complete"].includes(state.mode)) resumeTimer();
    });
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
      renderLevelSelect();
      const def = settings.default_preset_id;
      const defaultId = presetById(def) ? def : state.presets[0]?.id;
      if (!restoreSession()) {
        state.presetId = defaultId;
        syncLevelSelect();
        setupIdleTimer();
      } else {
        syncLevelSelect();
      }
      renderLiveStats();
    } catch (e) {
      console.error(e);
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") persistSession();
    else if (state.running) {
      if (state.mode !== "extend") syncRemainingFromClock();
      updateAll();
    }
  });

  document.addEventListener("DOMContentLoaded", init);
  window.addEventListener("beforeunload", persistSession);
})();
