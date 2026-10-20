// Phone-only touches for the Android app (loaded when templates render with mobile=True).
(function () {
  "use strict";

  // Dashboard: the year grid is wider than a phone, so open it at the latest
  // weeks instead of January. Re-run whenever the grid is redrawn (year change).
  function showLatestWeeks() {
    const scroll = document.querySelector(".heatmap-scroll");
    const grid = document.querySelector(".heatmap-grid");
    if (!scroll || !grid) return;
    const jump = () => {
      const d = new Date();
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const today = grid.querySelector(`[data-day="${iso}"]`);
      if (today) {
        const box = scroll.getBoundingClientRect();
        const cell = today.getBoundingClientRect();
        scroll.scrollLeft += cell.right - box.right + box.width * 0.15;
      } else {
        scroll.scrollLeft = scroll.scrollWidth;
      }
    };
    new MutationObserver(jump).observe(grid, { childList: true });
    jump();
  }

  // Settings: one long page is too much on a phone. Show a short list of
  // sections; tapping one opens just that section (address #timer, #sound...),
  // and Back returns to the list.
  const SECTION_NOTES = {
    timer: "Starting level, daily goal, auto-start",
    sound: "Bells, volume, minute pulse",
    appearance: "Light, dark or follow the phone",
    notifications: "Alerts when a block ends",
    combinations: "Your own focus and rest lengths",
    history: "Fix or add past sessions",
    sync: "Sign-in, profile, sync",
    about: "Version, updates, restore defaults",
  };

  function settingsAsList() {
    if (!document.body.classList.contains("page-settings") || document.body.classList.contains("page-history")) return;
    const nav = document.querySelector(".settings-nav");
    if (!nav) return;
    document.body.classList.add("settings-phone");

    // Until the phone has accounts, there is no Account section to open.
    const local = window.__MUHURTA_LOCAL__;
    if (local && !local.cloudConfigured) delete SECTION_NOTES.sync;
    // Phone notifications come later; the section still speaks of desktops.
    if (local && !local.notifications) delete SECTION_NOTES.notifications;

    nav.querySelectorAll(".settings-nav-link").forEach((link) => {
      const id = link.getAttribute("href").slice(1);
      if (!SECTION_NOTES[id]) { link.remove(); return; }
      const name = link.textContent.trim();
      link.innerHTML = "";
      const text = document.createElement("span");
      text.className = "settings-nav-text";
      const strong = document.createElement("strong");
      strong.textContent = name;
      const note = document.createElement("span");
      note.textContent = SECTION_NOTES[id];
      text.append(strong, note);
      const chev = document.createElement("span");
      chev.className = "settings-nav-chevron";
      chev.setAttribute("aria-hidden", "true");
      link.append(text, chev);
    });

    document.querySelectorAll(".pref-section").forEach((sec) => {
      if (!SECTION_NOTES[sec.id]) return;
      const back = document.createElement("a");
      back.href = "#";
      back.className = "settings-back";
      back.textContent = "\u2190 Settings";
      back.addEventListener("click", (e) => {
        e.preventDefault();
        if (history.state && history.state.fromList) history.back();
        else location.hash = "";
      });
      sec.prepend(back);
    });

    nav.addEventListener("click", (e) => {
      const link = e.target.closest(".settings-nav-link");
      if (!link) return;
      e.preventDefault();
      history.pushState({ fromList: true }, "", link.getAttribute("href"));
      show();
    });

    function show() {
      const id = location.hash.slice(1);
      const open = SECTION_NOTES[id] ? document.getElementById(id) : null;
      document.querySelectorAll(".pref-section").forEach((sec) => sec.classList.toggle("is-open", sec === open));
      document.body.dataset.settingsView = open ? "section" : "list";
      window.scrollTo(0, 0);
    }
    window.addEventListener("hashchange", show);
    window.addEventListener("popstate", show);
    show();
  }

  // History: Edit and Delete under every session is a lot to look at; show
  // them for the session you tap.
  document.addEventListener("click", (e) => {
    if (!document.body.classList.contains("page-history")) return;
    if (e.target.closest("button, a, input, select, textarea")) return;
    const item = e.target.closest(".history-item");
    if (!item) return;
    const open = !item.classList.contains("is-open");
    document.querySelectorAll(".history-item.is-open").forEach((el) => el.classList.remove("is-open"));
    item.classList.toggle("is-open", open);
  });

  document.addEventListener("DOMContentLoaded", () => {
    showLatestWeeks();
    settingsAsList();
  });
})();
