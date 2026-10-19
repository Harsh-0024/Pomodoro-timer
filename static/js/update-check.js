// When a newer version is out, a notice at the bottom of the window offers
// it. "Update now" has the app update itself: the Mac app downloads the new
// version and reopens; a git install restarts and this page reloads. Other
// downloads (Windows) get a link to the download page.
// Checked on load and every few hours, since the app can stay open for days.
// Silent on any failure, including being offline.
(function () {
  "use strict";
  const CHECK_EVERY = 3 * 60 * 60 * 1000;
  const DISMISS_KEY = "muhurata.update.dismissed";
  let shown = null;

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

  function show(d) {
    if (shown === d.latest || dismissed(d.latest)) return;
    document.querySelector(".update-bar")?.remove();
    shown = d.latest;

    const bar = el("div", "update-bar");
    bar.setAttribute("role", "status");
    const msg = el("span", "update-bar-text", `Version ${d.latest} is available. You have ${d.current}.`);
    const actions = el("span", "update-bar-actions");
    const later = el("button", "btn btn-quiet", "Later");
    later.type = "button";
    later.addEventListener("click", () => {
      try {
        sessionStorage.setItem(DISMISS_KEY, d.latest);
      } catch (_) {}
      bar.remove();
    });

    let main;
    if (d.how === "restart") {
      main = el("button", "btn btn-primary", "Update now");
      main.type = "button";
      main.addEventListener("click", () => {
        main.disabled = later.disabled = true;
        msg.textContent = "Updating… the app is back by itself in a few seconds.";
        const failed = (text) => {
          msg.textContent = text;
          main.disabled = later.disabled = false;
        };
        fetch("/api/update/restart", { method: "POST" })
          .then((r) => {
            if (!r.ok) throw new Error();
            waitForNewVersion(d.current, msg, failed);
          })
          .catch(() => {
            msg.textContent = "Could not update just now. Close this window and open Muhurta Pomodoro again.";
          });
      });
    } else {
      main = el("a", "btn btn-primary", "Download");
      main.href = d.url;
      main.target = "_blank";
      main.rel = "noopener";
    }
    actions.append(later, main);
    bar.append(msg, actions);
    document.body.appendChild(bar);
  }

  function check() {
    fetch("/api/version", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && d.update_available) show(d);
      })
      .catch(() => {});
  }

  check();
  setInterval(check, CHECK_EVERY);
})();
