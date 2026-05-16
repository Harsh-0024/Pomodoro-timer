(function () {
  "use strict";

  const SHORTCUTS = [
    { keys: "S", action: "Start or resume" },
    { keys: "Space", action: "Pause or resume" },
    { keys: "R", action: "Reset session" },
    { keys: "K", action: "Skip remaining rest (during rest)" },
    { keys: "B", action: "Begin rest (during extend)" },
    { keys: "3", action: "Skip rest (during extend)" },
    { keys: "1 · 2 · 3", action: "Choose options when a dialog is open" },
    { keys: "Space + /", action: "Open this guide" },
  ];

  function renderList(container) {
    if (!container) return;
    container.innerHTML = SHORTCUTS.map(
      (s) =>
        `<li class="shortcut-row"><kbd class="shortcut-keys">${s.keys}</kbd><span class="shortcut-action">${s.action}</span></li>`
    ).join("");
  }

  function openModal() {
    const modal = document.getElementById("shortcutsModal");
    if (!modal) return;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    modal.querySelector(".modal-close")?.focus();
  }

  function closeModal() {
    const modal = document.getElementById("shortcutsModal");
    if (!modal) return;
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
  }

  let spaceDown = false;

  function wireChord() {
    document.addEventListener("keydown", (e) => {
      if (e.code === "Space" || e.key === " ") {
        const t = e.target;
        if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT"))
          return;
        spaceDown = true;
      }
      if ((e.key === "/" || e.code === "Slash") && spaceDown) {
        e.preventDefault();
        window.__slashChordUsed = true;
        openModal();
        spaceDown = false;
      }
    });
    document.addEventListener("keyup", (e) => {
      if (e.code === "Space" || e.key === " ") spaceDown = false;
    });
  }

  function wireModal() {
    const modal = document.getElementById("shortcutsModal");
    if (!modal) return;
    renderList(document.getElementById("shortcutsList"));
    modal.querySelector(".modal-backdrop")?.addEventListener("click", closeModal);
    modal.querySelector(".modal-close")?.addEventListener("click", closeModal);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) closeModal();
    });
    document.getElementById("btnShowShortcuts")?.addEventListener("click", openModal);
  }

  document.addEventListener("DOMContentLoaded", () => {
    wireModal();
    wireChord();
  });

  window.MuhuratShortcuts = { open: openModal, close: closeModal, list: SHORTCUTS };
})();
