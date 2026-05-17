(function () {
  "use strict";

  const SHORTCUTS = [
    { keys: "S", action: "Start or resume" },
    { keys: "Space", action: "Pause or resume (release)" },
    { keys: "R", action: "Reset session" },
    { keys: "K", action: "Skip remaining rest (during rest)" },
    { keys: "B", action: "Begin rest (during extend)" },
    { keys: "3", action: "Skip rest (during extend)" },
    { keys: "1 · 2 · 3", action: "Choose options when a dialog is open" },
    { keys: "Space then /", action: "Open this guide" },
  ];

  let spaceAt = 0;

  function isInput(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

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

  function wireChord() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (isInput(e.target) && e.target?.id !== "levelSelect") return;
        if (e.code === "Space" || e.key === " ") {
          spaceAt = Date.now();
          return;
        }
        const isSlash =
          e.key === "/" || e.code === "Slash" || e.key === "?" || e.code === "Slash";
        if (isSlash && spaceAt && Date.now() - spaceAt < 600) {
          e.preventDefault();
          e.stopPropagation();
          window.__slashChordUsed = true;
          spaceAt = 0;
          openModal();
        }
      },
      true
    );
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
