// The Admin tab: people, computers and update rules, for the app's admin.
// Everything comes from /api/admin/*, which the server answers only for
// admins (supabase/schema.sql, admin section).
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const PLATFORMS = { darwin: "Mac", win32: "Windows", linux: "Linux" };
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function version(v) {
    return (String(v || "").match(/\d+/g) || []).slice(0, 3).map(Number);
  }
  function compare(a, b) {
    const x = version(a);
    const y = version(b);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  }

  function ago(iso) {
    if (!iso) return "never";
    const sec = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (sec < 90) return "just now";
    if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
    if (sec < 30 * 86400) return `${Math.round(sec / 86400)} days ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function hours(minutes) {
    const h = Number(minutes || 0) / 60;
    return h >= 10 ? `${Math.round(h).toLocaleString()} h` : `${h.toFixed(1)} h`;
  }

  function fullName(p) {
    return [p.first_name, p.last_name].filter(Boolean).join(" ");
  }

  function versionState(v, latest, policy) {
    if (!latest || !v) return { label: v || "?", tone: "" };
    const blocked = (policy?.blocked_versions || []).some((b) => compare(b, v) === 0);
    const tooOld = policy?.minimum_version && compare(v, policy.minimum_version) < 0;
    if (compare(v, latest) >= 0) return { label: `${v} · latest`, tone: "ok" };
    if (blocked || tooOld) return { label: `${v} · must update`, tone: "error" };
    return { label: `${v} · update available`, tone: "warn" };
  }

  /* ---------- render ---------- */

  function renderStats(data) {
    const people = data.people || [];
    const devices = data.devices || [];
    const now = Date.now();
    $("statPeople").textContent = people.length;
    $("statComputers").textContent = devices.length;
    $("statWeek").textContent = people.filter((p) => p.last_seen && now - Date.parse(p.last_seen) < WEEK_MS).length;
    if (data.latest) {
      const onLatest = devices.filter((d) => compare(d.app_version, data.latest) >= 0).length;
      $("statLatest").textContent = devices.length ? `${onLatest} / ${devices.length}` : "–";
      $("statLatestLabel").textContent = `on the latest version (${data.latest})`;
    }
  }

  function renderPeople(data) {
    const list = $("peopleList");
    list.replaceChildren();
    const versions = {};
    (data.devices || []).forEach((d) => {
      (versions[d.user_id] ||= []).push(d.app_version);
    });
    if (!(data.people || []).length) {
      list.append(el("p", "admin-empty", "No accounts yet."));
      return;
    }
    data.people.forEach((p) => {
      const row = el("div", "pref-row admin-person");
      const name = fullName(p);
      row.append(el("span", "account-avatar", (p.first_name || p.email || "?").charAt(0).toUpperCase()));
      const text = el("div", "pref-text");
      const title = el("span", "pref-name", name || p.email);
      if (p.is_admin) title.append(" ", el("span", "admin-badge", "Admin"));
      text.append(title);
      text.append(el("span", "pref-desc", [p.username && `@${p.username}`, name && p.email].filter(Boolean).join(" · ") || "No name added yet"));
      const facts = [
        `Online ${ago(p.last_seen)}`,
        `${p.computers} computer${p.computers === 1 ? "" : "s"}`,
        versions[p.id] ? `v${[...new Set(versions[p.id])].join(", v")}` : null,
        `${hours(p.focus_minutes)} focus`,
        `${Number(p.sessions || 0).toLocaleString()} sessions`,
        `joined ${ago(p.created_at)}`,
      ].filter(Boolean);
      text.append(el("span", "admin-facts", facts.join(" · ")));
      row.append(text);
      list.append(row);
    });
  }

  function renderComputers(data) {
    const list = $("computerList");
    list.replaceChildren();
    if (!(data.devices || []).length) {
      list.append(el("p", "admin-empty",
        "No computer has reported yet. Each one reports the next time it syncs after updating to 1.7.2 or later."));
      return;
    }
    data.devices.forEach((d) => {
      const row = el("div", "pref-row admin-computer");
      const text = el("div", "pref-text");
      text.append(el("span", "pref-name", d.person));
      text.append(el("span", "pref-desc", `${PLATFORMS[d.platform] || d.platform || "Unknown"} · online ${ago(d.last_seen)}`));
      const state = versionState(d.app_version, data.latest, data.policy);
      const badge = el("span", "admin-version", state.label);
      badge.dataset.tone = state.tone;
      row.append(text, badge);
      list.append(row);
    });
  }

  function renderRules(policy) {
    if (!policy) return;
    $("ruleMinimum").value = policy.minimum_version || "";
    $("ruleBlocked").value = (policy.blocked_versions || []).join(", ");
    $("ruleMessage").value = policy.message || "";
    $("rulesStatus").textContent = policy.updated_at ? `Last changed ${ago(policy.updated_at)}.` : "";
  }

  /* ---------- data ---------- */

  let current = null;

  async function load() {
    const error = $("adminError");
    try {
      const r = await fetch("/api/admin/overview", { headers: { Accept: "application/json" } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Couldn't load the admin data.");
      current = data;
      error.hidden = true;
      renderStats(data);
      renderPeople(data);
      renderComputers(data);
      renderRules(data.policy);
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  }

  $("btnRefresh").addEventListener("click", async (ev) => {
    const b = ev.currentTarget;
    b.disabled = true;
    b.textContent = "Refreshing…";
    await load();
    b.disabled = false;
    b.textContent = "Refresh";
  });

  $("rulesForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const button = $("btnSaveRules");
    const status = $("rulesStatus");
    const body = {
      minimum_version: $("ruleMinimum").value.trim(),
      blocked_versions: $("ruleBlocked").value.split(/[\s,]+/).filter(Boolean),
      message: $("ruleMessage").value.trim(),
    };
    // Requiring a version people can't update past would lock everyone out.
    if (current?.latest && body.minimum_version && compare(body.minimum_version, current.latest) > 0) {
      status.textContent = `The minimum can't be newer than the latest release (${current.latest}).`;
      status.dataset.tone = "error";
      return;
    }
    button.disabled = true;
    button.textContent = "Saving…";
    try {
      const r = await fetch("/api/admin/rules", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Couldn't save the rules.");
      if (current) current.policy = data;
      renderRules(data);
      status.textContent = "Saved. Copies pick it up within about an hour.";
      status.dataset.tone = "ok";
      if (current) renderComputers(current);
    } catch (e) {
      status.textContent = e.message;
      status.dataset.tone = "error";
    } finally {
      button.disabled = false;
      button.textContent = "Save rules";
    }
  });

  load();
})();
