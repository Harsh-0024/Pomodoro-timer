// The sign-in page: email, then the emailed code, then into the app.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  let email = "";

  async function api(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}),
    });
    let data = null;
    try {
      data = await r.json();
    } catch (_) {}
    if (!r.ok) throw new Error((data && data.error) || "Something went wrong. Try again.");
    return data;
  }

  function say(text, tone) {
    const el = $("signinMessage");
    el.hidden = !text;
    el.textContent = text || "";
    el.dataset.tone = tone || "";
  }

  async function busy(button, label, work) {
    const before = button.textContent;
    button.disabled = true;
    button.textContent = label;
    say("");
    try {
      return await work();
    } catch (e) {
      say(e.message, "error");
      return null;
    } finally {
      button.disabled = false;
      button.textContent = before;
    }
  }

  function showStep(step) {
    $("signinEmailForm").hidden = step !== "email";
    $("signinCodeForm").hidden = step !== "code";
    if (step === "code") {
      $("signinCodeHint").textContent = `Sent to ${email}. It can take a minute; check spam too.`;
      $("signinCode").value = "";
      $("signinCode").focus();
    } else {
      $("signinEmail").focus();
    }
  }

  async function sendCode(button) {
    const sent = await busy(button, "Sending…", () => api("/api/cloud/send-code", { email }));
    if (sent) {
      showStep("code");
      say("Code sent.", "ok");
    }
  }

  $("signinEmailForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    email = $("signinEmail").value.trim();
    if (!email) return $("signinEmail").focus();
    sendCode($("btnSigninSend"));
  });

  $("signinCodeForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = $("signinCode").value.replace(/\s+/g, "");
    if (!code) return $("signinCode").focus();
    // Signing in also fetches the account's data, which can take a moment.
    const st = await busy($("btnSigninVerify"), "Opening your account…", () =>
      api("/api/cloud/verify", { email, code })
    );
    if (st && st.signed_in) window.location.replace("/");
  });

  $("btnSigninResend").addEventListener("click", (ev) => sendCode(ev.currentTarget));
  $("btnSigninChange").addEventListener("click", () => {
    say("");
    showStep("email");
  });
})();
