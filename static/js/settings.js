(function () {
  "use strict";

  const toastEl = () => document.getElementById("settingsToast");
  let toastTimer = null;

  function toast(msg) {
    const el = toastEl();
    if (!el) return;
    el.textContent = msg;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.textContent = "";
    }, 2200);
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

  let saveTimer = null;

  function scheduleSave(body) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api("/api/settings", { method: "PUT", body: JSON.stringify(body) })
        .then(() => toast("Saved"))
        .catch((e) => toast(e.message || "Could not save"));
    }, 280);
  }

  function formatMinutes(min) {
    const n = Number(min || 0);
    if (n < 60) return `${n}m`;
    const h = Math.floor(n / 60);
    const r = n % 60;
    return r ? `${h}h ${r}m` : `${h}h`;
  }

  function renderDefaultPicker(picker, presets, currentId, onSelect) {
    if (!picker?.button || !picker?.text || !picker?.menu) return;
    const current = presets.find((p) => p.id === currentId) || presets[0];
    if (current) {
      picker.text.textContent = current.name;
      picker.button.setAttribute("aria-label", `Default level: ${current.name}`);
    }
    picker.menu.innerHTML = "";
    presets.forEach((p) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "level-option";
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", p.id === currentId ? "true" : "false");
      btn.classList.toggle("is-active", p.id === currentId);
      const totalWork = p.total_work_min || 4 * p.work_min;
      const totalRest = p.total_rest_min || 3 * p.short_rest_min + p.long_rest_min;
      const total = p.cycle_min || totalWork + totalRest;
      const focus = p.focus_ratio_pct != null ? `${Number(p.focus_ratio_pct).toFixed(1)}% focus` : "";
      btn.innerHTML = `
        <span>
          <span class="level-name">${escapeHtml(p.name)}</span>
          <span class="level-sub">${escapeHtml(p.subtitle || (p.kind === "custom" ? "Custom" : ""))}</span>
        </span>
        <span class="level-meta settings-level-meta">
          <span><strong>${p.work_min}</strong><small>focus</small></span>
          <span><strong>${p.short_rest_min}</strong><small>short</small></span>
          <span><strong>${p.long_rest_min}</strong><small>long</small></span>
          <span><strong>${formatMinutes(total)}</strong><small>total</small></span>
          ${focus ? `<span><strong>${focus}</strong><small>ratio</small></span>` : ""}
        </span>
      `;
      btn.addEventListener("click", () => onSelect(p.id));
      picker.menu.appendChild(btn);
    });
  }

  function closeDefaultPicker(picker) {
    picker?.menu?.classList.add("hidden");
    picker?.button?.setAttribute("aria-expanded", "false");
  }

  function toggleDefaultPicker(picker) {
    if (!picker?.menu || !picker?.button) return;
    const isClosed = picker.menu.classList.toggle("hidden");
    picker.button.setAttribute("aria-expanded", isClosed ? "false" : "true");
  }

  function renderCustomList(custom, onDelete) {
    const ul = document.getElementById("customList");
    if (!ul) return;
    ul.innerHTML = "";
    if (!custom.length) {
      const li = document.createElement("li");
      li.className = "custom-item";
      li.textContent = "No custom combinations yet.";
      ul.appendChild(li);
      return;
    }
    custom.forEach((p) => {
      const li = document.createElement("li");
      li.className = "custom-item";
      const left = document.createElement("div");
      left.innerHTML = `<strong>${escapeHtml(p.name)}</strong><br/><span>${p.work_min} · ${p.short_rest_min} · ${p.long_rest_min} min · ${p.focus_ratio_pct}% focus</span>`;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "btn btn-danger";
      btn.textContent = "Remove";
      btn.addEventListener("click", () => onDelete(p));
      li.appendChild(left);
      li.appendChild(btn);
      ul.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function soundOptions() {
    return window.FocusSounds?.options || [
      { id: "soothing-bell", label: "Soothing bell", detail: "Single long bell" },
      { id: "opening-bells", label: "Opening bells", detail: "Bright bell cue" },
      { id: "temple-gong", label: "Temple gong", detail: "Low ritual strike" },
      { id: "ghanta-trio", label: "Ghanta trio", detail: "Three temple bells" },
      { id: "soft-bell", label: "Soft bell", detail: "Gentle short chime" },
      { id: "bamboo-tick", label: "Bamboo tick", detail: "Quiet marker" },
    ];
  }

  function populateSoundSelect(el, current) {
    if (!el) return;
    const options = soundOptions();
    el.innerHTML = "";
    options.forEach((sound) => {
      const opt = document.createElement("option");
      opt.value = sound.id;
      opt.textContent = sound.label;
      if (sound.detail) opt.title = sound.detail;
      el.appendChild(opt);
    });
    el.value = options.some((sound) => sound.id === current) ? current : options[0]?.id || "";
  }

  async function reloadPresetsInto(defaultPicker, settings, onCustom) {
    const data = await api("/api/presets");
    const all = [...data.builtins, ...data.custom];
    if (defaultPicker) {
      renderDefaultPicker(defaultPicker, all, settings.default_preset_id, (id) => {
        settings.default_preset_id = id;
        renderDefaultPicker(defaultPicker, all, id, defaultPicker.onSelect);
        closeDefaultPicker(defaultPicker);
        scheduleSave({ default_preset_id: id });
      });
      defaultPicker.onSelect = (id) => {
        settings.default_preset_id = id;
        renderDefaultPicker(defaultPicker, all, id, defaultPicker.onSelect);
        closeDefaultPicker(defaultPicker);
        scheduleSave({ default_preset_id: id });
      };
    }
    renderCustomList(data.custom, onCustom);
    return data;
  }

  async function init() {
    if (window.__PAGE__ !== "settings") return;

    const s = await api("/api/settings");
    const setAutoWork = document.getElementById("setAutoWork");
    const setAutoBreak = document.getElementById("setAutoBreak");
    const setSound = document.getElementById("setSound");
    const setTick = document.getElementById("setTick");
    const setNotify = document.getElementById("setNotify");
    const defaultPicker = {
      button: document.getElementById("setDefaultPresetButton"),
      text: document.getElementById("setDefaultPresetText"),
      menu: document.getElementById("setDefaultPresetMenu"),
      onSelect: null,
    };
    const setVolume = document.getElementById("setVolume");
    const setVolumeVal = document.getElementById("setVolumeVal");
    const setProfile = document.getElementById("setProfile");
    const setTheme = document.getElementById("setTheme");
    const form = document.getElementById("customForm");
    const soundSelects = [
      { el: document.getElementById("setSoundRestEnd"), key: "manual_sound_rest_end", fallback: "opening-bells" },
      { el: document.getElementById("setSoundWorkBegin"), key: "manual_sound_work_begin", fallback: "temple-gong" },
      { el: document.getElementById("setSoundWorkEnd"), key: "manual_sound_work_end", fallback: "soothing-bell" },
      { el: document.getElementById("setSoundAction"), key: "manual_sound_action", fallback: "soft-bell" },
    ];

    if (setAutoWork) setAutoWork.checked = !!s.auto_start_work;
    if (setAutoBreak) setAutoBreak.checked = !!s.auto_start_break;
    if (setSound) setSound.checked = !!s.sound_enabled;
    if (setTick) setTick.checked = !!s.tick_sound_enabled;
    if (setNotify) setNotify.checked = !!s.notifications_enabled;
    if (setVolume) {
      setVolume.value = String(s.sound_volume ?? 70);
      if (setVolumeVal) setVolumeVal.textContent = `${setVolume.value}%`;
    }
    function syncProfile(value) {
      const current = value || "bold";
      setProfile?.querySelectorAll(".segment").forEach((btn) => {
        const active = btn.dataset.value === current;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-checked", active ? "true" : "false");
      });
    }
    syncProfile(s.sound_profile || "bold");

    soundSelects.forEach(({ el, key, fallback }) => {
      populateSoundSelect(el, s[key] || fallback);
    });

    function syncTheme(value) {
      const current = ["light", "dark", "system"].includes(value) ? value : "system";
      document.body.dataset.theme = current;
      setTheme?.querySelectorAll(".segment").forEach((btn) => {
        const active = btn.dataset.value === current;
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-checked", active ? "true" : "false");
      });
    }
    syncTheme(s.theme || "system");

    async function onDelete(p) {
      const id = p.id.replace("custom-", "");
      if (
        !(await askConfirm({
          title: "Remove combination?",
          message: `${p.name} will be removed from your saved combinations.`,
          accept: "Remove",
        }))
      ) return;
      try {
        await api(`/api/presets/${id}`, { method: "DELETE" });
        toast("Removed");
        await reloadPresetsInto(defaultPicker, await api("/api/settings"), onDelete);
      } catch (e) {
        toast(e.message || "Remove failed");
      }
    }

    await reloadPresetsInto(defaultPicker, s, onDelete);

    if (defaultPicker.button && !defaultPicker.button.dataset.wired) {
      defaultPicker.button.dataset.wired = "1";
      defaultPicker.button.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleDefaultPicker(defaultPicker);
      });
      document.addEventListener("click", (e) => {
        if (!document.getElementById("setDefaultPresetPicker")?.contains(e.target)) {
          closeDefaultPicker(defaultPicker);
        }
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") closeDefaultPicker(defaultPicker);
      });
    }

    function bindToggle(el, key) {
      if (!el) return;
      el.addEventListener("change", () => {
        s[key] = el.checked;
        scheduleSave({ [key]: el.checked });
      });
    }

    bindToggle(setAutoWork, "auto_start_work");
    bindToggle(setAutoBreak, "auto_start_break");
    bindToggle(setSound, "sound_enabled");
    bindToggle(setTick, "tick_sound_enabled");
    bindToggle(setNotify, "notifications_enabled");

    if (setVolume) {
      setVolume.addEventListener("input", () => {
        if (setVolumeVal) setVolumeVal.textContent = `${setVolume.value}%`;
        s.sound_volume = parseInt(setVolume.value, 10);
        scheduleSave({ sound_volume: s.sound_volume });
      });
    }

    if (setProfile) {
      setProfile.querySelectorAll(".segment").forEach((btn) => {
        btn.addEventListener("click", () => {
          const value = btn.dataset.value || "balanced";
          s.sound_profile = value;
          syncProfile(value);
          scheduleSave({ sound_profile: value });
        });
      });
    }

    soundSelects.forEach(({ el, key }) => {
      if (!el) return;
      el.addEventListener("change", () => {
        s[key] = el.value;
        scheduleSave({ [key]: el.value });
      });
    });

    document.querySelectorAll("[data-preview-for]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const select = document.getElementById(btn.dataset.previewFor || "");
        if (!select?.value || !window.FocusSounds?.preview) return;
        const previewSettings = { ...s };
        soundSelects.forEach(({ el, key }) => {
          if (el) previewSettings[key] = el.value;
        });
        previewSettings.sound_volume = setVolume ? parseInt(setVolume.value, 10) : previewSettings.sound_volume;
        window.FocusSounds.preview(select.value, previewSettings).catch((e) => {
          toast(e.message || "Could not play sound");
        });
      });
    });

    if (setTheme) {
      setTheme.querySelectorAll(".segment").forEach((btn) => {
        btn.addEventListener("click", () => {
          const value = btn.dataset.value || "dark";
          s.theme = value;
          syncTheme(value);
          scheduleSave({ theme: value });
        });
      });
    }

    if (form) {
      form.addEventListener("submit", async (ev) => {
        ev.preventDefault();
        const fd = new FormData(form);
        const name = String(fd.get("name") || "").trim();
        const work_min = parseInt(String(fd.get("work_min")), 10);
        const short_rest_min = parseInt(String(fd.get("short_rest_min")), 10);
        const long_rest_min = parseInt(String(fd.get("long_rest_min")), 10);
        try {
          await api("/api/presets", {
            method: "POST",
            body: JSON.stringify({
              name,
              work_min,
              short_rest_min,
              long_rest_min,
            }),
          });
          form.reset();
          toast("Combination saved");
          await reloadPresetsInto(defaultPicker, await api("/api/settings"), onDelete);
        } catch (e) {
          toast(e.message || "Could not save combination");
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
