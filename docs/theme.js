// Light or dark. The site follows the system setting unless the visitor has
// picked one with the switch in the top bar, which this browser remembers.
// Each page's <head> sets the starting theme before anything paints; this file
// wires up the switch and keeps following the system while nothing is picked.
// Pages can listen for the "themechange" event (index.html swaps screenshots).
(function () {
  "use strict";
  const KEY = "muhurta-theme";
  const root = document.documentElement;
  const media = matchMedia("(prefers-color-scheme: light)");

  function picked() {
    try {
      return localStorage.getItem(KEY);
    } catch (_) {
      return null;
    }
  }
  function remember(theme) {
    try {
      // Picking what the system already shows means "follow the system" again.
      if (theme === system()) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, theme);
    } catch (_) {}
  }
  const system = () => (media.matches ? "light" : "dark");

  function apply(theme, animate) {
    if (animate) {
      root.classList.add("theme-anim");
      setTimeout(() => root.classList.remove("theme-anim"), 450);
    }
    root.dataset.theme = theme;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f7f3ec" : "#070605");
    document.querySelectorAll(".theme-toggle").forEach((btn) => {
      const label = theme === "light" ? "Switch to dark mode" : "Switch to light mode";
      btn.setAttribute("aria-label", label);
      btn.title = label;
    });
    document.dispatchEvent(new CustomEvent("themechange", { detail: theme }));
  }

  apply(picked() || system(), false);

  media.addEventListener("change", () => {
    if (!picked()) apply(system(), true);
  });

  document.querySelectorAll(".theme-toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      const next = root.dataset.theme === "light" ? "dark" : "light";
      remember(next);
      apply(next, true);
    })
  );
})();
