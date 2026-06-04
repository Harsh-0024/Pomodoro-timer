(function () {
  "use strict";

  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayFormatter = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
  const fullDayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
  let selectedYear = Number(new URLSearchParams(window.location.search).get("year")) || new Date().getFullYear();
  let currentDashboardData = null;
  let rhythmSort = { key: "share", direction: "desc" };

  async function api(path) {
    const r = await fetch(path, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    const el = byId(id);
    if (el) el.textContent = value;
  }

  function parseDay(day) {
    return new Date(`${day}T00:00:00`);
  }

  function formatMinutes(minutes) {
    const n = Math.round(Number(minutes || 0));
    if (n < 60) return `${n}m`;
    const h = Math.floor(n / 60);
    const m = n % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  function formatSessionMinutes(minutes) {
    const n = Math.round(Number(minutes || 0));
    if (n < 60) return `${n} min`;
    const h = Math.floor(n / 60);
    const m = n % 60;
    return m ? `${h} hr ${m} min` : `${h} hr`;
  }

  function formatDays(n) {
    const count = Number(n || 0);
    return `${count} ${count === 1 ? "day" : "days"}`;
  }

  function formatDayRate(n) {
    const value = Number(n || 0);
    return `${value.toFixed(value >= 10 ? 0 : 1)}/wk`;
  }

  const heatStops = [
    [207, 227, 197],
    [135, 187, 120],
    [63, 138, 80],
    [20, 83, 52],
  ];

  function levelFor(day, goal) {
    const minutes = Number(day.focus_minutes || 0);
    if (minutes <= 0) return 0;
    if (minutes >= goal) return 4;
    if (minutes >= goal * 0.66) return 3;
    if (minutes >= goal * 0.33) return 2;
    return 1;
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function heatColor(ratio) {
    const value = clamp(Number(ratio || 0), 0, 1);
    if (value <= 0) return "";
    const scaled = value * (heatStops.length - 1);
    const index = Math.min(heatStops.length - 2, Math.floor(scaled));
    const local = scaled - index;
    const from = heatStops[index];
    const to = heatStops[index + 1];
    const rgb = from.map((channel, i) => Math.round(channel + (to[i] - channel) * local));
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  }

  function renderSummary(data) {
    const s = data.summary || {};
    const goal = Number(data.goal_minutes || 0);
    const year = data.range?.year || selectedYear;
    setText("goalValue", formatMinutes(goal));
    setText("totalFocusLabel", `Focus in ${year}`);
    setText("totalFocus", formatMinutes(s.total_focus_minutes));
    setText("activeDays", `${formatDays(s.active_days)} active`);
    setText("currentStreak", formatDays(s.current_streak));
    setText("longestStreak", `${formatDays(s.longest_streak)} longest`);
    setText("consistencyRate", formatDayRate(s.consistency_days_per_week));
    setText("consistencyNote", `${formatDays(s.active_days)} across ${formatDays(s.days_elapsed)}`);
    setText("productivity", s.productivity_pct == null ? "--" : `${Number(s.productivity_pct).toFixed(1)}%`);
    setText("restMinutes", `${formatMinutes(s.total_rest_minutes)} rest tracked`);
    setText(
      "heatmapSubtitle",
      `${formatMinutes(s.total_focus_minutes)} across ${formatDays(s.active_days)} in ${year}.`
    );
  }

  function renderYears(data) {
    const list = byId("yearList");
    if (!list) return;
    const years = data.range?.years || [selectedYear];
    const current = Number(data.range?.year || selectedYear);
    list.innerHTML = "";
    years.forEach((year) => {
      const item = document.createElement("li");
      const link = document.createElement("a");
      link.href = `?year=${year}`;
      link.className = "year-filter-item";
      link.textContent = String(year);
      link.setAttribute("aria-label", `Focus activity in ${year}`);
      if (year === current) {
        link.classList.add("is-active");
        link.setAttribute("aria-current", "true");
      }
      link.addEventListener("click", (event) => {
        event.preventDefault();
        if (selectedYear === year) return;
        selectedYear = year;
        const url = new URL(window.location.href);
        url.searchParams.set("year", String(year));
        window.history.pushState({ year }, "", url);
        loadDashboard(year);
      });
      item.appendChild(link);
      list.appendChild(item);
    });
  }

  function tooltipText(day, date) {
    const focus = formatMinutes(day.focus_minutes);
    const rest = formatMinutes(day.rest_minutes);
    const status = Number(day.focus_minutes || 0) > 0 ? `${focus} focus` : "No focus";
    return `${fullDayFormatter.format(date)} · ${status} · ${rest} rest`;
  }

  function showTooltip(event, text) {
    const tip = byId("heatmapTooltip");
    if (!tip) return;
    tip.textContent = text;
    tip.classList.remove("hidden");
    if (Number.isFinite(event.clientX) && Number.isFinite(event.clientY)) {
      moveTooltip(event);
      return;
    }
    const panel = document.querySelector(".heatmap-panel");
    const panelRect = panel?.getBoundingClientRect();
    const cellRect = event.currentTarget?.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const x = (cellRect?.left || 0) - (panelRect?.left || 0) + 12;
    const y = (cellRect?.top || 0) - (panelRect?.top || 0) - tipRect.height - 12;
    const maxX = Math.max(0, (panelRect?.width || window.innerWidth) - tipRect.width - 8);
    tip.style.left = `${clamp(x, 8, maxX)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function moveTooltip(event) {
    const tip = byId("heatmapTooltip");
    if (!tip || tip.classList.contains("hidden")) return;
    const panel = document.querySelector(".heatmap-panel");
    const panelRect = panel?.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const x = event.clientX - (panelRect?.left || 0) + 12;
    const y = event.clientY - (panelRect?.top || 0) - tipRect.height - 12;
    const maxX = Math.max(0, (panelRect?.width || window.innerWidth) - tipRect.width - 8);
    tip.style.left = `${clamp(x, 8, maxX)}px`;
    tip.style.top = `${Math.max(8, y)}px`;
  }

  function hideTooltip() {
    const tip = byId("heatmapTooltip");
    if (!tip) return;
    tip.classList.add("hidden");
  }

  function renderHeatmap(data) {
    const grid = byId("heatmapGrid");
    const months = byId("heatmapMonths");
    if (!grid || !months) return;
    const days = data.days || [];
    const firstDate = days[0] ? parseDay(days[0].day) : new Date();
    const leading = firstDate.getDay();
    const columns = Math.ceil((days.length + leading) / 7);
    const goal = Math.max(1, Number(data.goal_minutes || 1));
    const maxFocus = Math.max(...days.map((day) => Number(day.focus_minutes || 0)), goal);
    grid.setAttribute("aria-label", `Daily focus activity for ${data.range?.year || selectedYear}`);

    grid.innerHTML = "";
    months.innerHTML = "";
    grid.style.setProperty("--heat-cols", String(columns));
    months.style.setProperty("--heat-cols", String(columns));

    for (let i = 0; i < leading; i += 1) {
      const blank = document.createElement("span");
      blank.className = "heat-cell heat-empty";
      blank.setAttribute("aria-hidden", "true");
      grid.appendChild(blank);
    }

    let lastMonth = "";
    days.forEach((day, index) => {
      const date = parseDay(day.day);
      const week = Math.floor((index + leading) / 7) + 1;
      const month = monthNames[date.getMonth()];
      if (month !== lastMonth && (date.getDate() <= 7 || index === 0)) {
        const label = document.createElement("span");
        label.textContent = month;
        label.style.gridColumn = `${week} / span 4`;
        months.appendChild(label);
        lastMonth = month;
      }

      const cell = document.createElement("span");
      const level = levelFor(day, goal);
      cell.className = `heat-cell heat-level-${level} ${level > 0 ? "heat-active" : "heat-inactive"}`;
      if (level > 0) {
        cell.style.background = heatColor(Number(day.focus_minutes || 0) / maxFocus);
        const details = tooltipText(day, date);
        cell.tabIndex = 0;
        cell.setAttribute("aria-label", details);
        cell.addEventListener("mouseenter", (event) => showTooltip(event, details));
        cell.addEventListener("mouseover", (event) => showTooltip(event, details));
        cell.addEventListener("pointerover", (event) => showTooltip(event, details));
        cell.addEventListener("mousemove", moveTooltip);
        cell.addEventListener("mouseleave", hideTooltip);
        cell.addEventListener("pointerleave", hideTooltip);
        cell.addEventListener("click", (event) => showTooltip(event, details));
        cell.addEventListener("focus", (event) => showTooltip(event, details));
        cell.addEventListener("blur", hideTooltip);
      } else {
        cell.setAttribute("aria-hidden", "true");
      }
      grid.appendChild(cell);
    });
  }

  function renderRecent(data) {
    const list = byId("recentList");
    if (!list) return;
    const recent = data.recent_days || [];
    const max = Math.max(...recent.map((d) => Number(d.focus_minutes || 0)), Number(data.goal_minutes || 1));
    list.innerHTML = "";
    recent.forEach((day) => {
      const row = document.createElement("div");
      row.className = "recent-row";
      const width = Math.max(0, Math.min(100, (Number(day.focus_minutes || 0) / max) * 100));
      row.innerHTML = `
        <div class="recent-date">
          <strong>${dayFormatter.format(parseDay(day.day))}</strong>
          <span>${day.goal_met ? "Goal met" : Number(day.focus_minutes || 0) > 0 ? "Focus day" : "No focus"}</span>
        </div>
        <div class="recent-bar" aria-hidden="true"><span style="width: ${width}%"></span></div>
        <div class="recent-minutes">
          <strong>${formatMinutes(day.focus_minutes)}</strong>
          <span>${formatMinutes(day.rest_minutes)} rest</span>
        </div>
      `;
      list.appendChild(row);
    });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderRhythms(data) {
    const list = byId("rhythmList");
    const header = byId("rhythmHeader");
    if (!list) return;
    const rhythms = [...(data.top_presets || [])];
    list.innerHTML = "";
    if (header) header.innerHTML = "";
    if (!rhythms.length) {
      const empty = document.createElement("p");
      empty.className = "empty-note";
      empty.textContent = "No rhythm data yet.";
      list.appendChild(empty);
      return;
    }

    const headings = [
      ["session", "Session"],
      ["share", "Share"],
    ];
    headings.forEach(([key, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `rhythm-heading rhythm-heading-${key}`;
      button.dataset.sort = key;
      const active = rhythmSort.key === key;
      button.setAttribute("aria-sort", active ? (rhythmSort.direction === "asc" ? "ascending" : "descending") : "none");
      button.textContent = active ? `${label} ${rhythmSort.direction === "asc" ? "↑" : "↓"}` : label;
      button.addEventListener("click", () => {
        rhythmSort = {
          key,
          direction: active ? (rhythmSort.direction === "asc" ? "desc" : "asc") : "desc",
        };
        renderRhythms(currentDashboardData || data);
      });
      if (header) header.appendChild(button);
    });

    const valueForSort = (rhythm) => {
      if (rhythmSort.key === "session") return Number(rhythm.session_minutes || 0);
      return Number(rhythm.focus_pct || 0);
    };
    rhythms.sort((a, b) => {
      const av = valueForSort(a);
      const bv = valueForSort(b);
      const order = rhythmSort.direction === "asc" ? 1 : -1;
      if (av < bv) return -1 * order;
      if (av > bv) return 1 * order;
      return String(a.name || "").localeCompare(String(b.name || ""));
    });

    const maxShare = Math.max(...rhythms.map((rhythm) => Number(rhythm.focus_pct || 0)), 1);
    rhythms.forEach((rhythm) => {
      const row = document.createElement("div");
      row.className = "rhythm-row";
      const pct = Math.max(0, Math.min(100, Number(rhythm.focus_pct || 0)));
      const width = pct > 0 ? Math.max(4, (pct / maxShare) * 100) : 0;
      const sessionText = rhythm.session_minutes ? formatSessionMinutes(rhythm.session_minutes) : "";
      row.innerHTML = `
        <div class="rhythm-copy">
          <strong>${escapeHtml(rhythm.name)}</strong>
          <span>${escapeHtml(sessionText)}</span>
        </div>
        <strong class="rhythm-focus">${formatMinutes(rhythm.focus_minutes)}</strong>
        <div class="rhythm-share">
          <div class="rhythm-track" aria-hidden="true"><span style="width: ${width}%"></span></div>
          <strong class="rhythm-percent">${pct.toFixed(1)}%</strong>
        </div>
      `;
      list.appendChild(row);
    });
  }

  async function loadDashboard(year) {
    try {
      const data = await api(`/api/dashboard?year=${encodeURIComponent(year)}`);
      currentDashboardData = data;
      selectedYear = Number(data.range?.year || year);
      renderSummary(data);
      renderYears(data);
      renderHeatmap(data);
      renderRecent(data);
      renderRhythms(data);
    } catch (e) {
      setText("heatmapSubtitle", "Dashboard data could not be loaded.");
      console.error(e);
    }
  }

  async function init() {
    if (window.__PAGE__ !== "dashboard") return;
    window.addEventListener("popstate", () => {
      selectedYear = Number(new URLSearchParams(window.location.search).get("year")) || new Date().getFullYear();
      loadDashboard(selectedYear);
    });
    loadDashboard(selectedYear);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
