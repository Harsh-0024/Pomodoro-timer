// The sign-in page.
//   Sign in:         email + password.
//   Create account:  email -> emailed code -> choose a password.
//   Forgot password: email -> emailed code -> choose a new password.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const MIN_PASSWORD = 8;
  let email = "";
  let purpose = "new"; // "new" (create an account) or "reset" (forgot password)

  const COPY = {
    signin: ["Sign in", "Your sessions, combinations and settings are kept in your account, so they follow you to every computer you sign in on."],
    new: ["Create your account", "Free. First we check your email with a code, then you choose a password."],
    reset: ["Reset your password", "We email you a code, then you choose a new password."],
  };

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

  function setCopy(key) {
    $("signinTitle").textContent = COPY[key][0];
    $("signinLede").textContent = COPY[key][1];
  }

  // One of: "signin", "email", "code", "password".
  function showStep(step) {
    $("signinPasswordForm").hidden = step !== "signin";
    $("signinEmailForm").hidden = step !== "email";
    $("signinCodeForm").hidden = step !== "code";
    $("signinNewPasswordForm").hidden = step !== "password";
    setCopy(step === "signin" ? "signin" : purpose);
    if (step === "signin") {
      if (email) $("signinEmail").value = email;
      (email ? $("signinPassword") : $("signinEmail")).focus();
    } else if (step === "email") {
      $("signinCodeEmail").value = email || $("signinEmail").value.trim();
      $("signinCodeEmail").focus();
    } else if (step === "code") {
      $("signinCodeHint").textContent = `Sent to ${email}. It can take a minute; check spam too.`;
      $("signinCode").value = "";
      $("signinCode").focus();
    } else if (step === "password") {
      $("signinNewPasswordEmail").value = email; // lets password managers save it under this email
      $("signinNewPassword").value = "";
      $("signinNewPassword2").value = "";
      $("signinNewPassword").focus();
    }
  }

  function startCodeFlow(kind) {
    purpose = kind;
    say("");
    showStep("email");
  }

  async function sendCode(button) {
    const sent = await busy(button, "Sending…", () => api("/api/cloud/send-code", { email, purpose }));
    if (sent) {
      showStep("code");
      say("Code sent.", "ok");
    }
  }

  function enterApp(st) {
    if (st && st.signed_in) window.location.replace("/");
  }

  $("signinPasswordForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    email = $("signinEmail").value.trim();
    const password = $("signinPassword").value;
    if (!email) return $("signinEmail").focus();
    if (!password) return $("signinPassword").focus();
    // Signing in also fetches the account's data, which can take a moment.
    enterApp(await busy($("btnSignin"), "Opening your account…", () => api("/api/cloud/sign-in", { email, password })));
  });

  $("btnCreate").addEventListener("click", () => startCodeFlow("new"));
  $("btnForgot").addEventListener("click", () => startCodeFlow("reset"));
  document.querySelectorAll("[data-back]").forEach((b) =>
    b.addEventListener("click", () => {
      say("");
      showStep("signin");
    })
  );

  $("signinEmailForm").addEventListener("submit", (ev) => {
    ev.preventDefault();
    email = $("signinCodeEmail").value.trim();
    if (!email) return $("signinCodeEmail").focus();
    sendCode($("btnSendCode"));
  });

  $("signinCodeForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = $("signinCode").value.replace(/\s+/g, "");
    if (!code) return $("signinCode").focus();
    const st = await busy($("btnVerify"), "Checking…", () => api("/api/cloud/verify", { email, code }));
    if (st) {
      showStep("password");
      say("Email confirmed. Now choose a password.", "ok");
    }
  });
  $("btnResend").addEventListener("click", (ev) => sendCode(ev.currentTarget));

  $("signinNewPasswordForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const password = $("signinNewPassword").value;
    if (password.length < MIN_PASSWORD) {
      say(`Use at least ${MIN_PASSWORD} characters.`, "error");
      return $("signinNewPassword").focus();
    }
    if (password !== $("signinNewPassword2").value) {
      say("The two passwords don't match.", "error");
      return $("signinNewPassword2").focus();
    }
    enterApp(await busy($("btnSavePassword"), "Opening your account…", () => api("/api/cloud/set-password", { password })));
  });

  $("btnCancelPending").addEventListener("click", async (ev) => {
    if (await busy(ev.currentTarget, "…", () => api("/api/cloud/cancel"))) {
      email = "";
      $("signinEmail").value = "";
      showStep("signin");
    }
  });

  // Came back after the code but before choosing a password: pick up there.
  const pending = $("signin").dataset.pendingEmail;
  if (pending) {
    email = pending;
    purpose = "new";
    showStep("password");
    $("signinTitle").textContent = "Choose a password";
    $("signinLede").textContent = `Your email ${pending} is confirmed. Choose a password to finish.`;
  } else {
    showStep("signin");
  }
})();
