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

  document.addEventListener("DOMContentLoaded", showLatestWeeks);
})();
