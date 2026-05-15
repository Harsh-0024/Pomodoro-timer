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

  function fillDefaultSelect(select, presets, currentId) {
    select.innerHTML = "";
    presets.forEach((p) => {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = `${p.name} — ${p.subtitle || p.kind}`;
      select.appendChild(o);
    });
    if (presets.some((p) => p.id === currentId)) {
      select.value = currentId;
    }
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

  async function reloadPresetsInto(select, settings, onCustom) {
    const data = await api("/api/presets");
    const all = [...data.builtins, ...data.custom];
    if (select) fillDefaultSelect(select, all, settings.default_preset_id);
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
    const setChimeWork = document.getElementById("setChimeWork");
    const setChimeBreak = document.getElementById("setChimeBreak");
    const setNotify = document.getElementById("setNotify");
    const setDefaultPreset = document.getElementById("setDefaultPreset");
    const form = document.getElementById("customForm");

    if (setAutoWork) setAutoWork.checked = !!s.auto_start_work;
    if (setAutoBreak) setAutoBreak.checked = !!s.auto_start_break;
    if (setSound) setSound.checked = !!s.sound_enabled;
    if (setTick) setTick.checked = !!s.tick_sound_enabled;
    if (setChimeWork) setChimeWork.checked = !!s.chime_work_end;
    if (setChimeBreak) setChimeBreak.checked = !!s.chime_break_end;
    if (setNotify) setNotify.checked = !!s.notifications_enabled;

    async function onDelete(p) {
      const id = p.id.replace("custom-", "");
      if (!confirm(`Remove “${p.name}”?`)) return;
      try {
        await api(`/api/presets/${id}`, { method: "DELETE" });
        toast("Removed");
        await reloadPresetsInto(setDefaultPreset, await api("/api/settings"), onDelete);
      } catch (e) {
        toast(e.message || "Remove failed");
      }
    }

    await reloadPresetsInto(setDefaultPreset, s, onDelete);

    function bindToggle(el, key) {
      if (!el) return;
      el.addEventListener("change", () => {
        scheduleSave({ [key]: el.checked });
      });
    }

    bindToggle(setAutoWork, "auto_start_work");
    bindToggle(setAutoBreak, "auto_start_break");
    bindToggle(setSound, "sound_enabled");
    bindToggle(setTick, "tick_sound_enabled");
    bindToggle(setChimeWork, "chime_work_end");
    bindToggle(setChimeBreak, "chime_break_end");
    bindToggle(setNotify, "notifications_enabled");

    if (setDefaultPreset) {
      setDefaultPreset.addEventListener("change", () => {
        scheduleSave({ default_preset_id: setDefaultPreset.value });
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
          await reloadPresetsInto(setDefaultPreset, await api("/api/settings"), onDelete);
        } catch (e) {
          toast(e.message || "Could not save combination");
        }
      });
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
