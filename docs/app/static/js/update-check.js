// When a newer version is out, a notice at the bottom of the window offers
// it. "Update now" has the app update itself: the Mac app downloads the new
// version and reopens; a git install restarts and this page reloads. Other
// downloads (Windows) get a link to the download page.
// When the owner requires it (docs/update-policy.json), a screen covers the
// app instead, with no "Later": this version can't be used until it updates.
// Checked on load and every hour, since the app can stay open for days.
// Silent when offline; Settings > About shows whether checks are working.
(function () {
  "use strict";
  const CHECK_EVERY = 60 * 60 * 1000;
  const DISMISS_KEY = "muhurata.update.dismissed";
  let shown = null; // "bar:<version>" or "required:<version>"

  function dismissed(version) {
    try {
      return sessionStorage.getItem(DISMISS_KEY) === version;
    } catch (_) {
      return false;
    }
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text) node.textContent = text;
    return node;
  }

  function waitForNewVersion(from, msg, onError) {
    const started = Date.now();
    const poll = () => {
      fetch("/api/version", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d && d.update_error) onError(d.update_error);
          else if (d && d.current !== from) location.reload();
          else retry();
        })
        .catch(retry);
    };
    const retry = () => {
      // An update that also installs components can take a minute or two.
      if (Date.now() - started < 4 * 60 * 1000) setTimeout(poll, 2000);
      else msg.textContent = "The update is taking long. Close this window and open Muhurta Pomodoro again.";
    };
    setTimeout(poll, 2000);
  }

  // The "Update now" (or "Download") button, shared by the notice and the
  // required screen. `others` are disabled while updating.
  function updateButton(d, msg, others) {
    if (d.how !== "restart") {
      const link = el("a", "btn btn-primary", "Download the new version");
      link.href = d.url;
      link.target = "_blank";
      link.rel = "noopener";
      return link;
    }
    const button = el("button", "btn btn-primary", "Update now");
    button.type = "button";
    button.addEventListener("click", () => {
      const all = [button, ...others];
      all.forEach((b) => (b.disabled = true));
      const before = msg.textContent;
      msg.textContent = "Updating… the app is back by itself in a few seconds.";
      const failed = (text) => {
        msg.textContent = text || before;
        all.forEach((b) => (b.disabled = false));
      };
      fetch("/api/update/restart", { method: "POST" })
        .then((r) => {
          if (!r.ok) throw new Error();
          waitForNewVersion(d.current, msg, failed);
        })
        .catch(() => failed("Could not update just now. Close this window and open Muhurta Pomodoro again."));
    });
    return button;
  }

  function showBar(d) {
    if (shown === `bar:${d.latest}` || dismissed(d.latest)) return;
    document.querySelector(".update-bar")?.remove();
    shown = `bar:${d.latest}`;

    const bar = el("div", "update-bar");
    bar.setAttribute("role", "status");
    const text = d.message
      ? `Version ${d.latest} is available. ${d.message}`
      : `Version ${d.latest} is available. You have ${d.current}.`;
    const msg = el("span", "update-bar-text", text);
    const actions = el("span", "update-bar-actions");
    const later = el("button", "btn btn-quiet", "Later");
    later.type = "button";
    later.addEventListener("click", () => {
      try {
        sessionStorage.setItem(DISMISS_KEY, d.latest);
      } catch (_) {}
      bar.remove();
    });
    actions.append(later, updateButton(d, msg, [later]));
    bar.append(msg, actions);
    document.body.appendChild(bar);
  }

  // Keys pressed while the required screen is up stay with it, so shortcuts
  // can't start the timer underneath.
  function trapKeys(ev) {
    const screen = document.querySelector(".update-required");
    if (!screen) return;
    if (!screen.contains(ev.target)) {
      ev.preventDefault();
      screen.querySelector("button, a")?.focus();
    }
    ev.stopPropagation();
  }

  function showRequired(d) {
    if (shown === `required:${d.latest}`) return;
    document.querySelector(".update-bar")?.remove();
    document.querySelector(".update-required")?.remove();
    shown = `required:${d.latest}`;

    const screen = el("div", "update-required");
    screen.setAttribute("role", "alertdialog");
    screen.setAttribute("aria-modal", "true");
    screen.setAttribute("aria-labelledby", "updateRequiredTitle");
    const card = el("div", "update-required-card");
    const kicker = el("p", "signin-kicker", "Update required");
    const title = el("h2", "update-required-title", `Please update to version ${d.latest}`);
    title.id = "updateRequiredTitle";
    const body = el("p", "update-required-text",
      d.message || `Version ${d.current} is no longer supported. Update to keep using Muhurta Pomodoro.`);
    const note = el("p", "update-required-note",
      "Your sessions and settings are safe in your account and come back after the update.");
    const button = updateButton(d, body, []);
    card.append(kicker, title, body, button, note);
    screen.append(card);
    document.body.appendChild(screen);
    document.addEventListener("keydown", trapKeys, true);
    button.focus();
  }

  // Checks have failed for days: say so once per session, quietly, so a
  // copy that can't see updates doesn't stay stuck without anyone knowing.
  const STALE_DAYS = 3;
  const STALE_KEY = "muhurata.update.stale-dismissed";

  function showStale(d) {
    try {
      if (sessionStorage.getItem(STALE_KEY)) return;
    } catch (_) {}
    if (shown || document.querySelector(".update-bar")) return;
    shown = "stale";
    const bar = el("div", "update-bar");
    bar.setAttribute("role", "status");
    const msg = el("span", "update-bar-text",
      `Couldn't check for updates for ${d.check_failing_days} days (${d.check_error}). ` +
      "Check your internet connection, or get the latest version from the website.");
    const actions = el("span", "update-bar-actions");
    const later = el("button", "btn btn-quiet", "OK");
    later.type = "button";
    later.addEventListener("click", () => {
      try {
        sessionStorage.setItem(STALE_KEY, "1");
      } catch (_) {}
      bar.remove();
    });
    const link = el("a", "btn btn-primary", "Open website");
    link.href = d.url;
    link.target = "_blank";
    link.rel = "noopener";
    actions.append(later, link);
    bar.append(msg, actions);
    document.body.appendChild(bar);
  }

  function check() {
    fetch("/api/version", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && !d.update_available && d.check_error && d.check_failing_days >= STALE_DAYS) return showStale(d);
        if (!d || !d.update_available) return;
        if (shown === "stale") {
          document.querySelector(".update-bar")?.remove();
          shown = null;
        }
        if (d.required) showRequired(d);
        else showBar(d);
      })
      .catch(() => {});
  }

  check();
  setInterval(check, CHECK_EVERY);
  window.addEventListener("muhurata:check-updates", check); // Settings > Check now
})();
