// After an update, a card shows once what changed since the version this
// computer had before (release_notes.py). Closing it marks it as seen.
(function () {
  "use strict";

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function show(data) {
    const modal = el("div", "modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-labelledby", "whatsNewTitle");
    const backdrop = el("div", "modal-backdrop");
    const sheet = el("div", "modal-sheet whats-new-sheet");
    const title = el("h2", "modal-title", `What's new in ${data.current}`);
    title.id = "whatsNewTitle";
    sheet.append(el("p", "modal-kicker", "Updated"), title);

    data.notes.forEach((block, i) => {
      if (data.notes.length > 1) sheet.append(el("p", "whats-new-version", i === 0 ? `Version ${block.version}` : `Also in ${block.version}`));
      const list = el("ul", "whats-new-list");
      block.items.forEach((item) => list.append(el("li", null, item)));
      sheet.append(list);
    });

    const actions = el("div", "modal-actions");
    const ok = el("button", "btn btn-primary", "Got it");
    ok.type = "button";
    if (data.get_app_url) {
      // Running the Terminal install on a Mac: point the way to the app.
      sheet.append(
        el("p", "modal-copy whats-new-switch",
          "You installed with the Terminal. Switch to the app whenever you like: it uses " +
          "the same history on this computer, so nothing is lost."));
      ok.className = "btn btn-quiet";
      const get = el("a", "btn btn-primary", "Get the Mac app");
      get.href = data.get_app_url;
      get.target = "_blank";
      get.rel = "noopener";
      actions.append(ok, get);
    } else {
      actions.append(ok);
    }
    sheet.append(actions);
    modal.append(backdrop, sheet);

    const close = () => {
      modal.remove();
      document.body.classList.remove("modal-open");
      document.removeEventListener("keydown", onKey);
      fetch("/api/whats-new/seen", { method: "POST" }).catch(() => {});
    };
    const onKey = (e) => {
      if (e.key === "Escape" || e.key === "Enter") close();
    };
    ok.addEventListener("click", close);
    backdrop.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(modal);
    document.body.classList.add("modal-open");
    ok.focus();
  }

  fetch("/api/whats-new", { headers: { Accept: "application/json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (d && d.notes && d.notes.length) show(d);
    })
    .catch(() => {});
})();
