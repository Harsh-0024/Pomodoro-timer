(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const GOAL_MIN = 15;
  const GOAL_MAX = 960;
  const MUHURAT_MIN = 48;

  // Each cue has one sound choice and one or more on/off switches. "Small
  // actions" covers three separate chime flags that always move together here.
  const CUES = [
    {
      name: "Focus begins",
      desc: "When a focus block starts.",
      soundKey: "manual_sound_work_begin",
      fallback: "temple-gong",
      chimeKeys: ["chime_session_start"],
    },
    {
      name: "Focus ends",
      desc: "When a focus block is complete.",
      soundKey: "manual_sound_work_end",
      fallback: "soothing-bell",
      chimeKeys: ["chime_work_end"],
    },
    {
      name: "Rest ends",
      desc: "Time to return to focus.",
      soundKey: "manual_sound_rest_end",
      fallback: "opening-bells",
      chimeKeys: ["chime_break_end"],
    },
    {
      name: "Small actions",
      desc: "Adding to the rest pool, choosing, skipping.",
      soundKey: "manual_sound_action",
      fallback: "soft-bell",
      chimeKeys: ["chime_pool_add", "chime_choice", "chime_skip"],
    },
  ];

  let s = {};
  let presets = [];
  let customPresets = [];
  let editingId = null;

  /* ---------- helpers ---------- */

  let toastTimer = null;
  function toast(msg, kind) {
    const el = $("settingsToast");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("is-error", kind === "error");
    el.classList.add("is-visible");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("is-visible"), kind === "error" ? 4000 : 1600);
  }

  function askConfirm(options) {
    if (window.MuhurataDialog?.confirm) return window.MuhurataDialog.confirm(options);
    return Promise.resolve(window.confirm(options?.message || options?.title || "Continue?"));
  }

  async function api(path, opts) {
    const r = await fetch(path, {
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      ...opts,
    });
    if (!r.ok) {
      let err = r.statusText;
      try {
        const j = await r.json();
        if (j.error) err = j.error;
      } catch (_) {}
      throw new Error(err);
    }
    if (r.status === 204) return null;
    return r.json();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatMinutes(min) {
    const n = Number(min || 0);
    if (n < 60) return `${n}m`;
    const h = Math.floor(n / 60);
    const r = n % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }

  function formatMuhurat(min) {
    const quarters = Math.round((min / MUHURAT_MIN) * 4);
    const whole = Math.floor(quarters / 4);
    const frac = ["", "¼", "½", "¾"][quarters % 4];
    const text = `${whole || (frac ? "" : "0")}${frac}`;
    const exact = quarters * (MUHURAT_MIN / 4) === min;
    return `${exact ? "" : "≈ "}${text} muhurat`;
  }

  function cycleOf(p) {
    const work = p.total_work_min || 4 * p.work_min;
    const rest = p.total_rest_min || 3 * p.short_rest_min + p.long_rest_min;
    const total = p.cycle_min || work + rest;
    const ratio = p.focus_ratio_pct != null ? Number(p.focus_ratio_pct) : (100 * work) / total;
    return { work, rest, total, ratio: Math.round(ratio * 10) / 10 };
  }

  /* ---------- saving ---------- */

  // Changes are merged and sent together: a plain debounce would drop every
  // change but the last one when two controls are touched in quick succession.
  let pending = {};
  let saveTimer = null;

  function save(patch) {
    Object.assign(s, patch);
    Object.assign(pending, patch);
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
  }

  async function flush() {
    saveTimer = null;
    const body = pending;
    pending = {};
    if (!Object.keys(body).length) return;
    try {
      await api("/api/settings", { method: "PUT", body: JSON.stringify(body) });
      toast("Saved");
    } catch (e) {
      toast(e.message || "Could not save", "error");
      try {
        s = { ...(await api("/api/settings")), ...pending };
        applyAll();
      } catch (_) {}
    }
  }

  function flushOnLeave() {
    if (!Object.keys(pending).length) return;
    const body = JSON.stringify(pending);
    pending = {};
    try {
      fetch("/api/settings", {
        method: "PUT",
        body,
        keepalive: true,
        headers: { "Content-Type": "application/json" },
      });
    } catch (_) {}
  }

  /* ---------- toggles & segmented controls ---------- */

  const TOGGLES = [
    ["setAutoWork", "auto_start_work"],
    ["setAutoBreak", "auto_start_break"],
    ["setSound", "sound_enabled"],
    ["setTick", "tick_sound_enabled"],
    ["setNotify", "notifications_enabled"],
  ];

  function syncSegmented(group, value) {
    group?.querySelectorAll(".segment").forEach((btn) => {
      const active = btn.dataset.value === value;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-checked", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    });
  }

  function wireSegmented(group, onPick) {
    if (!group) return;
    const buttons = [...group.querySelectorAll(".segment")];
    buttons.forEach((btn, i) => {
      btn.addEventListener("click", () => onPick(btn.dataset.value));
      btn.addEventListener("keydown", (e) => {
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!step) return;
        e.preventDefault();
        const next = buttons[(i + step + buttons.length) % buttons.length];
        next.focus();
        onPick(next.dataset.value);
      });
    });
  }

  function applyTheme(value) {
    const theme = ["light", "dark", "system"].includes(value) ? value : "system";
    document.body.dataset.theme = theme;
    syncSegmented($("setTheme"), theme);
  }

  /* ---------- daily goal ---------- */

  function goalStepFor(v) {
    if (v < 120) return 15;
    if (v < 360) return 30;
    return 60;
  }

  function nextGoal(v, dir) {
    let out;
    if (dir > 0) {
      const st = goalStepFor(v);
      out = Math.floor(v / st) * st + st;
    } else {
      const st = goalStepFor(v - 1);
      out = Math.ceil(v / st) * st - st;
    }
    return Math.min(GOAL_MAX, Math.max(GOAL_MIN, out));
  }

  function renderGoal() {
    const v = Number(s.daily_focus_goal_minutes || 120);
    const out = $("setGoalValue");
    if (out) {
      out.innerHTML = `<strong>${formatMinutes(v)}</strong><small>${formatMuhurat(v)}</small>`;
    }
    if ($("setGoalDown")) $("setGoalDown").disabled = v <= GOAL_MIN;
    if ($("setGoalUp")) $("setGoalUp").disabled = v >= GOAL_MAX;
  }

  /* ---------- sound ---------- */

  function soundOptions() {
    return window.FocusSounds?.options || [
      { id: "soothing-bell", label: "Soothing bell" },
      { id: "opening-bells", label: "Opening bells" },
      { id: "temple-gong", label: "Temple gong" },
      { id: "ghanta-trio", label: "Ghanta trio" },
      { id: "soft-bell", label: "Soft bell" },
      { id: "bamboo-tick", label: "Bamboo tick" },
    ];
  }

  function cueOn(cue) {
    return cue.chimeKeys.some((k) => s[k] !== false);
  }

  function renderCues() {
    const list = $("cueList");
    if (!list) return;
    list.innerHTML = "";
    CUES.forEach((cue, i) => {
      const row = document.createElement("div");
      row.className = "pref-row cue-row";
      row.dataset.cue = String(i);
      const selectId = `cueSound${i}`;
      const toggleId = `cueOn${i}`;
      row.innerHTML = `
        <label class="toggle cue-toggle" for="${toggleId}">
          <input type="checkbox" id="${toggleId}" />
          <span class="toggle-ui" aria-hidden="true"></span>
          <span class="pref-text">
            <span class="pref-name">${cue.name}</span>
            <span class="pref-desc">${cue.desc}</span>
          </span>
        </label>
        <div class="cue-picker">
          <select class="select" id="${selectId}" aria-label="${cue.name} sound"></select>
          <button type="button" class="btn-preview" aria-label="Play ${cue.name.toLowerCase()} sound" title="Play">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7.5-4.5z" /></svg>
          </button>
        </div>
      `;
      const select = row.querySelector("select");
      soundOptions().forEach((sound) => {
        const opt = document.createElement("option");
        opt.value = sound.id;
        opt.textContent = sound.label;
        if (sound.detail) opt.title = sound.detail;
        select.appendChild(opt);
      });

      row.querySelector("input").addEventListener("change", (e) => {
        const patch = {};
        cue.chimeKeys.forEach((k) => (patch[k] = e.target.checked));
        save(patch);
        syncSoundState();
      });
      select.addEventListener("change", () => {
        save({ [cue.soundKey]: select.value });
        preview(row, select.value);
      });
      row.querySelector(".btn-preview").addEventListener("click", () => preview(row, select.value));
      list.appendChild(row);
    });
  }

  function syncCues() {
    const ids = soundOptions().map((o) => o.id);
    CUES.forEach((cue, i) => {
      const toggle = $(`cueOn${i}`);
      const select = $(`cueSound${i}`);
      if (toggle) toggle.checked = cueOn(cue);
      if (select) select.value = ids.includes(s[cue.soundKey]) ? s[cue.soundKey] : cue.fallback;
    });
  }

  function preview(row, soundId) {
    if (!soundId || !window.FocusSounds?.preview) return;
    if (Number(s.sound_volume) === 0) {
      toast("Volume is at 0%");
      return;
    }
    const btn = row.querySelector(".btn-preview");
    btn?.classList.add("is-playing");
    setTimeout(() => btn?.classList.remove("is-playing"), 900);
    window.FocusSounds.preview(soundId, s).catch((e) => toast(e.message || "Could not play sound", "error"));
  }

  // Everything under the master switch dims and locks while sound is off, and
  // a cue's sound picker locks while that cue is switched off.
  function syncSoundState() {
    const soundOn = !!s.sound_enabled;
    document.querySelectorAll("[data-needs-sound]").forEach((el) => {
      el.classList.toggle("is-disabled", !soundOn);
    });
    ["setVolume", "setTick"].forEach((id) => {
      if ($(id)) $(id).disabled = !soundOn;
    });
    $("setProfile")?.querySelectorAll(".segment").forEach((b) => (b.disabled = !soundOn));
    CUES.forEach((cue, i) => {
      const on = cueOn(cue);
      const row = document.querySelector(`.cue-row[data-cue="${i}"]`);
      row?.classList.toggle("is-off", !on);
      if ($(`cueOn${i}`)) $(`cueOn${i}`).disabled = !soundOn;
      if ($(`cueSound${i}`)) $(`cueSound${i}`).disabled = !soundOn || !on;
      const btn = row?.querySelector(".btn-preview");
      if (btn) btn.disabled = !soundOn || !on;
    });
  }

  function renderVolume() {
    const v = String(s.sound_volume ?? 70);
    const input = $("setVolume");
    if (input) {
      input.value = v;
      input.style.setProperty("--fill", `${v}%`);
    }
    if ($("setVolumeVal")) $("setVolumeVal").textContent = `${v}%`;
  }

  /* ---------- notifications ---------- */

  function notifyPermission() {
    return "Notification" in window ? Notification.permission : "unsupported";
  }

  function renderNotifyStatus() {
    const text = $("notifyStatus");
    const btn = $("btnNotifyAction");
    const row = $("notifyStatusRow");
    if (!text || !btn || !row) return;
    const perm = notifyPermission();
    let msg = "";
    let action = "";
    let tone = "";
    if (perm === "unsupported") {
      msg = "This browser can't show desktop notifications.";
      tone = "warn";
    } else if (!s.notifications_enabled) {
      msg = "Off. Bells still ring if sound is on.";
    } else if (perm === "granted") {
      msg = "Allowed in this browser.";
      action = "Send a test";
      tone = "ok";
    } else if (perm === "default") {
      msg = "Your browser still needs permission before it can show them.";
      action = "Allow";
      tone = "warn";
    } else {
      msg = "Blocked by your browser. Allow notifications for this site in the browser's site settings, then reload this page.";
      tone = "warn";
    }
    text.textContent = msg;
    row.dataset.tone = tone;
    btn.textContent = action;
    btn.classList.toggle("hidden", !action);
  }

  async function requestNotify() {
    if (notifyPermission() !== "default") return;
    try {
      await Notification.requestPermission();
    } catch (_) {}
    renderNotifyStatus();
  }

  function sendTestNotification() {
    try {
      new Notification("Muhurata Timer", { body: "Notifications are working.", silent: true });
      toast("Test sent");
    } catch (_) {
      toast("Could not show a notification", "error");
    }
  }

  /* ---------- default level picker ---------- */

  const picker = {
    root: () => $("setDefaultPresetPicker"),
    button: () => $("setDefaultPresetButton"),
    menu: () => $("setDefaultPresetMenu"),
  };

  function presetSummary(p) {
    const c = cycleOf(p);
    return `${p.work_min} · ${p.short_rest_min} · ${p.long_rest_min} min · ${formatMinutes(c.total)} cycle`;
  }

  function renderPicker() {
    const menu = picker.menu();
    if (!menu) return;
    const currentId = s.default_preset_id;
    const current = presets.find((p) => p.id === currentId) || presets[0];
    if (current) {
      $("setDefaultPresetText").textContent = current.name;
      $("setDefaultPresetSub").textContent = presetSummary(current);
    }
    menu.innerHTML = "";
    presets.forEach((p) => {
      const c = cycleOf(p);
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "level-option";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", p.id === current?.id ? "true" : "false");
      btn.classList.toggle("is-active", p.id === current?.id);
      btn.tabIndex = -1;
      btn.dataset.id = p.id;
      btn.innerHTML = `
        <span>
          <span class="level-name">${escapeHtml(p.name)}</span>
          <span class="level-sub">${escapeHtml(p.subtitle || (p.kind === "custom" ? "Your rhythm" : ""))}</span>
        </span>
        <span class="level-meta settings-level-meta">
          <span><strong>${p.work_min}</strong><small>focus</small></span>
          <span><strong>${p.short_rest_min}</strong><small>short</small></span>
          <span><strong>${p.long_rest_min}</strong><small>long</small></span>
          <span><strong>${formatMinutes(c.total)}</strong><small>cycle</small></span>
          <span><strong>${c.ratio}%</strong><small>focus</small></span>
        </span>
      `;
      btn.addEventListener("click", () => {
        closePicker(true);
        if (p.id === s.default_preset_id) return;
        save({ default_preset_id: p.id });
        renderPicker();
        renderCustomList();
      });
      menu.appendChild(btn);
    });
  }

  function pickerOptions() {
    return [...(picker.menu()?.querySelectorAll(".level-option") || [])];
  }

  function openPicker() {
    picker.menu()?.classList.remove("hidden");
    picker.button()?.setAttribute("aria-expanded", "true");
    const opts = pickerOptions();
    const target = opts.find((o) => o.classList.contains("is-active")) || opts[0];
    target?.focus({ preventScroll: true });
  }

  function closePicker(refocus) {
    const menu = picker.menu();
    if (!menu || menu.classList.contains("hidden")) return;
    menu.classList.add("hidden");
    picker.button()?.setAttribute("aria-expanded", "false");
    if (refocus) picker.button()?.focus();
  }

  function wirePicker() {
    const button = picker.button();
    const menu = picker.menu();
    if (!button || !menu) return;
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (menu.classList.contains("hidden")) openPicker();
      else closePicker(false);
    });
    button.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openPicker();
      }
    });
    menu.addEventListener("keydown", (e) => {
      const opts = pickerOptions();
      const i = opts.indexOf(document.activeElement);
      const target = {
        ArrowDown: opts[Math.min(opts.length - 1, i + 1)],
        ArrowUp: opts[Math.max(0, i - 1)],
        Home: opts[0],
        End: opts[opts.length - 1],
      }[e.key];
      if (target) {
        e.preventDefault();
        target.focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closePicker(true);
      } else if (e.key === "Tab") {
        closePicker(false);
      }
    });
    document.addEventListener("click", (e) => {
      if (!picker.root()?.contains(e.target)) closePicker(false);
    });
  }

  /* ---------- combinations ---------- */

  async function loadPresets() {
    const data = await api("/api/presets");
    presets = [...data.builtins, ...data.custom];
    customPresets = data.custom;
    renderPicker();
    renderCustomList();
  }

  function renderCustomList() {
    const ul = $("customList");
    if (!ul) return;
    ul.innerHTML = "";
    if (!customPresets.length) {
      const li = document.createElement("li");
      li.className = "custom-empty";
      li.textContent = "No combinations yet. The ones you save appear here and in the timer's level menu.";
      ul.appendChild(li);
      return;
    }
    customPresets.forEach((p) => {
      const c = cycleOf(p);
      const isDefault = p.id === s.default_preset_id;
      const li = document.createElement("li");
      li.className = "custom-item";
      li.classList.toggle("is-editing", p.id === editingId);
      li.innerHTML = `
        <div class="custom-main">
          <div class="custom-name">
            <strong>${escapeHtml(p.name)}</strong>
            ${isDefault ? '<span class="badge">Default</span>' : ""}
          </div>
          <div class="custom-chips">
            <span><b>${p.work_min}</b> focus</span>
            <span><b>${p.short_rest_min}</b> short</span>
            <span><b>${p.long_rest_min}</b> long</span>
            <span><b>${formatMinutes(c.total)}</b> cycle</span>
            <span><b>${c.ratio}%</b> focus</span>
          </div>
        </div>
        <div class="custom-actions">
          ${isDefault ? "" : '<button type="button" class="btn btn-ghost btn-small" data-act="default">Make default</button>'}
          <button type="button" class="btn btn-quiet btn-small" data-act="edit">Edit</button>
          <button type="button" class="btn btn-danger btn-small" data-act="remove">Remove</button>
        </div>
      `;
      li.querySelector('[data-act="default"]')?.addEventListener("click", () => {
        save({ default_preset_id: p.id });
        renderPicker();
        renderCustomList();
      });
      li.querySelector('[data-act="edit"]').addEventListener("click", () => startEdit(p));
      li.querySelector('[data-act="remove"]').addEventListener("click", () => removePreset(p));
      ul.appendChild(li);
    });
  }

  function formValues() {
    const form = $("customForm");
    const fd = new FormData(form);
    return {
      name: String(fd.get("name") || "").trim(),
      work_min: parseInt(String(fd.get("work_min")), 10),
      short_rest_min: parseInt(String(fd.get("short_rest_min")), 10),
      long_rest_min: parseInt(String(fd.get("long_rest_min")), 10),
    };
  }

  const LIMITS = [
    ["presetWork", "work_min", "Focus", 180],
    ["presetShort", "short_rest_min", "Short rest", 60],
    ["presetLong", "long_rest_min", "Long rest", 120],
  ];

  function validate(v) {
    const problems = [];
    const nameEl = $("presetName");
    nameEl.removeAttribute("aria-invalid");
    if (!v.name) {
      nameEl.setAttribute("aria-invalid", "true");
      problems.push("Give it a name");
    }
    LIMITS.forEach(([id, key, label, max]) => {
      const el = $(id);
      el.removeAttribute("aria-invalid");
      const n = v[key];
      if (!Number.isInteger(n) || n < 1 || n > max) {
        el.setAttribute("aria-invalid", "true");
        problems.push(`${label} must be 1–${max} min`);
      }
    });
    return problems;
  }

  function renderPresetPreview() {
    const el = $("presetPreview");
    if (!el) return;
    const v = formValues();
    const ok = LIMITS.every(([, key, , max]) => Number.isInteger(v[key]) && v[key] >= 1 && v[key] <= max);
    if (!ok) {
      el.textContent = "Fill in the durations to see the full cycle.";
      el.classList.remove("is-ready");
      return;
    }
    const c = cycleOf(v);
    el.innerHTML = `One cycle: <strong>${formatMinutes(c.total)}</strong> · ${formatMinutes(c.work)} focus, ${formatMinutes(c.rest)} rest · <strong>${c.ratio}%</strong> focus`;
    el.classList.add("is-ready");
  }

  function startEdit(p) {
    editingId = p.id;
    $("presetName").value = p.name;
    $("presetWork").value = p.work_min;
    $("presetShort").value = p.short_rest_min;
    $("presetLong").value = p.long_rest_min;
    $("btnSavePreset").textContent = "Update combination";
    $("btnCancelEdit").classList.remove("hidden");
    $("customForm").classList.add("is-editing");
    renderPresetPreview();
    renderCustomList();
    $("customForm").scrollIntoView({ block: "center", behavior: "smooth" });
    $("presetName").focus({ preventScroll: true });
  }

  function endEdit() {
    editingId = null;
    const form = $("customForm");
    form.reset();
    form.classList.remove("is-editing");
    form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    $("btnSavePreset").textContent = "Save combination";
    $("btnCancelEdit").classList.add("hidden");
    renderPresetPreview();
    renderCustomList();
  }

  async function submitPreset(ev) {
    ev.preventDefault();
    const v = formValues();
    const problems = validate(v);
    if (problems.length) {
      toast(problems[0], "error");
      $("customForm").querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    const editing = editingId;
    try {
      if (editing) {
        await api(`/api/presets/${editing.replace("custom-", "")}`, { method: "PUT", body: JSON.stringify(v) });
      } else {
        await api("/api/presets", { method: "POST", body: JSON.stringify(v) });
      }
      endEdit();
      await loadPresets();
      toast(editing ? "Combination updated" : "Combination saved");
    } catch (e) {
      toast(e.message || "Could not save combination", "error");
    }
  }

  async function removePreset(p) {
    const ok = await askConfirm({
      title: "Remove combination?",
      message: `${p.name} will be removed from your saved combinations.`,
      accept: "Remove",
    });
    if (!ok) return;
    try {
      await api(`/api/presets/${p.id.replace("custom-", "")}`, { method: "DELETE" });
      if (editingId === p.id) endEdit();
      // The server falls back to a built-in level when the default is removed.
      if (s.default_preset_id === p.id) {
        const fresh = await api("/api/settings");
        s.default_preset_id = fresh.default_preset_id;
      }
      await loadPresets();
      toast("Removed");
    } catch (e) {
      toast(e.message || "Remove failed", "error");
    }
  }

  /* ---------- keyboard reference ---------- */

  function renderShortcuts() {
    const ul = $("shortcutGrid");
    const list = window.MuhuratShortcuts?.list;
    if (!ul || !list) return;
    const keysHtml = (keys) =>
      keys
        .split(" · ")
        .map((alt) =>
          alt
            .split(" + ")
            .map((k) => `<kbd>${escapeHtml(k)}</kbd>`)
            .join('<span class="kbd-plus">+</span>')
        )
        .join('<span class="kbd-or">/</span>');
    ul.innerHTML = list
      .map((sc) => `<li><span class="shortcut-keys">${keysHtml(sc.keys)}</span><span>${escapeHtml(sc.action)}</span></li>`)
      .join("");
  }

  /* ---------- section nav ---------- */

  function wireSectionNav() {
    const links = [...document.querySelectorAll(".settings-nav-link")];
    const sections = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
    if (!("IntersectionObserver" in window) || !sections.length) return;
    const nav = document.querySelector(".settings-nav");
    const setActive = (id) => {
      links.forEach((a) => {
        const on = a.getAttribute("href") === `#${id}`;
        a.classList.toggle("is-active", on);
        // On phones the nav is a horizontal strip; keep the current tab in it.
        if (on && nav && nav.scrollWidth > nav.clientWidth) {
          nav.scrollTo({ left: a.offsetLeft - nav.clientWidth / 2 + a.offsetWidth / 2, behavior: "smooth" });
        }
      });
    };
    const visible = new Map();
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((en) => visible.set(en.target.id, en.isIntersecting));
        const first = sections.find((sec) => visible.get(sec.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-15% 0px -55% 0px" }
    );
    sections.forEach((sec) => io.observe(sec));
    links.forEach((a) => a.addEventListener("click", () => setActive(a.getAttribute("href").slice(1))));
  }

  /* ---------- reset ---------- */

  async function resetSettings() {
    const ok = await askConfirm({
      title: "Restore default settings?",
      message: "Timer, sound, theme and notification preferences go back to how they started. Your combinations and focus history are kept.",
      accept: "Restore",
    });
    if (!ok) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pending = {};
    try {
      s = await api("/api/settings/reset", { method: "POST" });
      applyAll();
      toast("Defaults restored");
    } catch (e) {
      toast(e.message || "Could not restore defaults", "error");
    }
  }

  /* ---------- wiring ---------- */

  function applyAll() {
    TOGGLES.forEach(([id, key]) => {
      if ($(id)) $(id).checked = !!s[key];
    });
    renderVolume();
    syncSegmented($("setProfile"), s.sound_profile || "bold");
    applyTheme(s.theme);
    renderGoal();
    syncCues();
    syncSoundState();
    renderNotifyStatus();
    renderPicker();
    renderCustomList();
  }

  function wireControls() {
    TOGGLES.forEach(([id, key]) => {
      $(id)?.addEventListener("change", (e) => {
        save({ [key]: e.target.checked });
        if (key === "sound_enabled") syncSoundState();
        if (key === "notifications_enabled") {
          renderNotifyStatus();
          if (e.target.checked) requestNotify();
        }
      });
    });

    $("setVolume")?.addEventListener("input", (e) => {
      save({ sound_volume: parseInt(e.target.value, 10) });
      renderVolume();
    });

    wireSegmented($("setProfile"), (value) => {
      save({ sound_profile: value });
      syncSegmented($("setProfile"), value);
    });

    wireSegmented($("setTheme"), (value) => {
      save({ theme: value });
      applyTheme(value);
    });

    [
      ["setGoalDown", -1],
      ["setGoalUp", 1],
    ].forEach(([id, dir]) => {
      $(id)?.addEventListener("click", () => {
        save({ daily_focus_goal_minutes: nextGoal(Number(s.daily_focus_goal_minutes || 120), dir) });
        renderGoal();
      });
    });

    $("btnNotifyAction")?.addEventListener("click", () => {
      if (notifyPermission() === "granted") sendTestNotification();
      else requestNotify();
    });

    const form = $("customForm");
    form?.addEventListener("submit", submitPreset);
    form?.addEventListener("input", (e) => {
      e.target.removeAttribute?.("aria-invalid");
      renderPresetPreview();
    });
    $("btnCancelEdit")?.addEventListener("click", endEdit);
    $("btnResetSettings")?.addEventListener("click", resetSettings);

    window.addEventListener("pagehide", flushOnLeave);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") flushOnLeave();
      else renderNotifyStatus(); // permission may have changed in browser settings
    });
  }

  async function init() {
    if (window.__PAGE__ !== "settings") return;
    renderCues();
    renderShortcuts();
    wirePicker();
    wireControls();
    wireSectionNav();
    try {
      s = await api("/api/settings");
      applyAll();
      await loadPresets();
    } catch (e) {
      toast(e.message || "Could not load settings", "error");
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
