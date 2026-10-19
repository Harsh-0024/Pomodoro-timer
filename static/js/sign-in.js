// The sign-in page.
//   Sign in:         email + password.
//   Create account:  name, username, email -> emailed code -> password.
//   Forgot password: email -> emailed code -> new password.
// The password and username rules match cloud.py, which checks them again.
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const USERNAME_RE = /^[a-z][a-z0-9_.]{2,19}$/;
  const DRAFT_KEY = "muhurata.signup.draft"; // name/username between the code and the password

  let mode = "signin"; // "signin", "new" or "reset"
  let email = "";
  let profile = null; // { first_name, last_name, username } while creating an account

  /* ---------- helpers ---------- */

  async function api(path, body, method) {
    const r = await fetch(path, {
      method: method || "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try {
      data = await r.json();
    } catch (_) {}
    if (!r.ok) {
      const err = new Error((data && data.error) || "Something went wrong. Try again.");
      err.field = data && data.field;
      throw err;
    }
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
      if (e.field === "username") flagUsername(currentUsernameInput(), "taken");
      return null;
    } finally {
      button.disabled = false;
      button.textContent = before;
    }
  }

  function saveDraft() {
    try {
      sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ email, profile }));
    } catch (_) {}
  }
  function loadDraft() {
    try {
      return JSON.parse(sessionStorage.getItem(DRAFT_KEY) || "null");
    } catch (_) {
      return null;
    }
  }
  function clearDraft() {
    try {
      sessionStorage.removeItem(DRAFT_KEY);
    } catch (_) {}
  }

  /* ---------- steps ---------- */

  const STEPS = ["stepSignin", "stepDetails", "stepResetEmail", "stepCode", "stepPassword"];

  function copyFor(step) {
    const flow = mode === "reset" ? "Reset password" : "Create account";
    switch (step) {
      case "stepDetails":
        return [`${flow} · step 1 of 3`, "Create your account", "Free. Tell us a little about you to get started.", 1];
      case "stepResetEmail":
        return [`${flow} · step 1 of 3`, "Forgot your password?", "No problem. We'll email you a code, then you can choose a new one.", 1];
      case "stepCode":
        return [`${flow} · step 2 of 3`, "Check your email", `We sent a code to ${email}. It can take a minute.`, 2];
      case "stepPassword":
        return mode === "reset"
          ? [`${flow} · step 3 of 3`, "Choose a new password", "You'll use it with your email to sign in.", 3]
          : [`${flow} · step 3 of 3`, "Choose a password", "Last step. You'll use it with your email to sign in.", 3];
      default:
        return ["Free · your own account", "Welcome back",
          "Sign in to pick up where you left off. Your sessions, combinations and settings follow you to every computer.", 0];
    }
  }

  function show(step) {
    STEPS.forEach((id) => ($(id).hidden = id !== step));
    const [kicker, title, lede, dot] = copyFor(step);
    $("signinKicker").textContent = kicker;
    $("signinTitle").textContent = title;
    $("signinLede").textContent = lede;
    $("signinProgress").hidden = !dot;
    document.querySelectorAll(".signin-dot").forEach((d) => {
      d.classList.toggle("is-done", Number(d.dataset.dot) < dot);
      d.classList.toggle("is-current", Number(d.dataset.dot) === dot);
    });

    if (step === "stepSignin") {
      if (email) $("signinEmail").value = email;
      ($("signinEmail").value ? $("signinPassword") : $("signinEmail")).focus();
    } else if (step === "stepDetails") {
      if (email && !$("signupEmail").value) $("signupEmail").value = email;
      $("firstName").focus();
    } else if (step === "stepResetEmail") {
      $("resetEmail").value = email || $("signinEmail").value.trim();
      $("resetEmail").focus();
    } else if (step === "stepCode") {
      const from = $("signin").dataset.emailFrom;
      $("codeFrom").textContent = from
        ? `It comes from ${from}. Not there? Look in Spam and mark it "Not spam" so the next one arrives in your inbox.`
        : "Not there? Look in your Spam folder.";
      $("signinCode").value = "";
      $("signinCode").focus();
    } else if (step === "stepPassword") {
      $("passwordUsername").value = email; // lets password managers file it under this email
      $("newPasswordLabel").textContent = mode === "reset" ? "New password" : "Password";
      $("btnSavePassword").textContent = mode === "reset" ? "Save new password" : "Create account";
      $("newPassword").value = "";
      $("newPassword2").value = "";
      renderPassword();
      ($("lateDetails").hidden ? $("newPassword") : $("lateFirstName")).focus();
    }
  }

  /* ---------- username ---------- */

  function currentUsernameInput() {
    return $("lateDetails").hidden ? $("username") : $("lateUsername");
  }

  function flagUsername(input, state, name) {
    const note = $(input.getAttribute("aria-describedby"));
    const msgs = {
      format: "3–20 letters, numbers, _ or . — starting with a letter.",
      checking: "Checking…",
      free: `@${name} is available.`,
      taken: "That username is taken. Try another.",
      bad: "Use 3–20 letters, numbers, _ or ., starting with a letter.",
      unknown: "Couldn't check right now; we'll check again when you continue.",
    };
    note.textContent = msgs[state];
    note.dataset.tone = state === "free" ? "ok" : state === "taken" || state === "bad" ? "error" : "";
    input.setAttribute("aria-invalid", String(state === "taken" || state === "bad"));
  }

  function wireUsername(input) {
    let timer = null;
    let seq = 0;
    input.addEventListener("input", () => {
      const cleaned = input.value.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9_.]/g, "");
      if (cleaned !== input.value) input.value = cleaned;
      clearTimeout(timer);
      if (!cleaned) return flagUsername(input, "format");
      if (!USERNAME_RE.test(cleaned)) return flagUsername(input, cleaned.length < 3 ? "format" : "bad");
      flagUsername(input, "checking");
      const mine = ++seq;
      timer = setTimeout(async () => {
        try {
          const r = await fetch(`/api/cloud/username-available?name=${encodeURIComponent(cleaned)}`);
          const data = await r.json();
          if (mine !== seq) return; // typed again since
          if (!r.ok) return flagUsername(input, "unknown");
          flagUsername(input, data.available ? "free" : "taken", cleaned);
        } catch (_) {
          if (mine === seq) flagUsername(input, "unknown");
        }
      }, 400);
    });
  }

  function readProfile(first, last, user) {
    const p = {
      first_name: first.value.trim().replace(/\s+/g, " "),
      last_name: last.value.trim().replace(/\s+/g, " "),
      username: user.value.trim().toLowerCase(),
    };
    if (!p.first_name) {
      say("Enter your first name.", "error");
      first.focus();
      return null;
    }
    if (!USERNAME_RE.test(p.username)) {
      flagUsername(user, "bad");
      say("Choose a username: 3–20 letters, numbers, _ or ., starting with a letter.", "error");
      user.focus();
      return null;
    }
    if (user.getAttribute("aria-invalid") === "true") {
      say("That username is taken. Try another.", "error");
      user.focus();
      return null;
    }
    return p;
  }

  /* ---------- password ---------- */

  function passwordChecks(pw) {
    const lowered = pw.toLowerCase();
    const personal = [profile && profile.username, (email || "").split("@")[0]]
      .filter((part) => part && part.length >= 3)
      .every((part) => !lowered.includes(part.toLowerCase()));
    return {
      length: pw.length >= 8,
      lower: /[a-z]/.test(pw),
      upper: /[A-Z]/.test(pw),
      number: /\d/.test(pw),
      symbol: /[^A-Za-z0-9\s]/.test(pw),
      personal: personal && pw.length > 0,
    };
  }

  function renderPassword() {
    const pw = $("newPassword").value;
    const checks = passwordChecks(pw);
    document.querySelectorAll("#passwordRules li").forEach((li) => {
      li.classList.toggle("is-met", Boolean(checks[li.dataset.rule]));
    });
    const met = Object.values(checks).filter(Boolean).length;
    const allMet = met === 6;
    let level = 0;
    let label = "";
    if (pw) {
      if (!allMet) {
        level = met <= 3 ? 1 : 2;
        label = met <= 3 ? "Too weak" : "Almost there";
      } else if (pw.length >= 16) {
        level = 5;
        label = "Very strong";
      } else if (pw.length >= 12) {
        level = 4;
        label = "Strong";
      } else {
        level = 3;
        label = "Good — longer is even better";
      }
    }
    $("strengthBar").style.width = `${level * 20}%`;
    $("strengthBar").dataset.level = String(level);
    $("strengthLabel").textContent = label;
    renderMatch();
    return allMet;
  }

  function renderMatch() {
    const a = $("newPassword").value;
    const b = $("newPassword2").value;
    const note = $("matchNote");
    if (!b) {
      note.textContent = "";
      note.dataset.tone = "";
    } else if (a === b) {
      note.textContent = "Passwords match.";
      note.dataset.tone = "ok";
    } else {
      note.textContent = "Passwords don't match yet.";
      note.dataset.tone = "error";
    }
  }

  /* ---------- small comforts ---------- */

  document.querySelectorAll(".password-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const input = $(btn.dataset.toggle);
      const showing = input.type === "text";
      input.type = showing ? "password" : "text";
      btn.textContent = showing ? "Show" : "Hide";
      btn.setAttribute("aria-label", showing ? "Show password" : "Hide password");
      input.focus();
    });
  });

  document.querySelectorAll("[data-caps-for]").forEach((note) => {
    const input = $(note.dataset.capsFor);
    const check = (ev) => {
      if (ev.getModifierState) note.hidden = !ev.getModifierState("CapsLock");
    };
    input.addEventListener("keydown", check);
    input.addEventListener("keyup", check);
    input.addEventListener("blur", () => (note.hidden = true));
  });

  wireUsername($("username"));
  wireUsername($("lateUsername"));
  $("newPassword").addEventListener("input", renderPassword);
  $("newPassword2").addEventListener("input", renderMatch);
  $("lateUsername").addEventListener("input", renderPassword);

  /* ---------- sign in ---------- */

  function enterApp(st) {
    if (st && st.signed_in) {
      clearDraft();
      window.location.replace("/");
    }
  }

  $("stepSignin").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    email = $("signinEmail").value.trim();
    const password = $("signinPassword").value;
    if (!email) {
      say("Enter your email.", "error");
      return $("signinEmail").focus();
    }
    if (!password) {
      say("Enter your password.", "error");
      return $("signinPassword").focus();
    }
    // Signing in also fetches the account's data, which can take a moment.
    enterApp(await busy($("btnSignin"), "Signing in…", () => api("/api/cloud/sign-in", { email, password })));
  });

  $("btnCreate").addEventListener("click", () => {
    mode = "new";
    email = $("signinEmail").value.trim();
    say("");
    show("stepDetails");
  });
  $("btnForgot").addEventListener("click", () => {
    mode = "reset";
    email = $("signinEmail").value.trim();
    say("");
    show("stepResetEmail");
  });
  document.querySelectorAll("[data-back]").forEach((b) =>
    b.addEventListener("click", () => {
      mode = "signin";
      say("");
      show("stepSignin");
    })
  );

  /* ---------- create account / reset ---------- */

  async function sendCode(button) {
    const body = mode === "new" ? { email, purpose: "new", ...profile } : { email, purpose: "reset" };
    const sent = await busy(button, "Sending…", () => api("/api/cloud/send-code", body));
    if (sent) {
      saveDraft();
      show("stepCode");
      say("Code sent.", "ok");
    }
    return sent;
  }

  $("stepDetails").addEventListener("submit", (ev) => {
    ev.preventDefault();
    say("");
    const p = readProfile($("firstName"), $("lastName"), $("username"));
    if (!p) return;
    email = $("signupEmail").value.trim();
    if (!email) {
      say("Enter your email.", "error");
      return $("signupEmail").focus();
    }
    profile = p;
    $("lateDetails").hidden = true;
    sendCode($("btnDetails"));
  });

  $("stepResetEmail").addEventListener("submit", (ev) => {
    ev.preventDefault();
    email = $("resetEmail").value.trim();
    if (!email) {
      say("Enter your email.", "error");
      return $("resetEmail").focus();
    }
    profile = null;
    $("lateDetails").hidden = true;
    sendCode($("btnResetSend"));
  });

  $("stepCode").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const code = $("signinCode").value.replace(/\s+/g, "");
    if (!code) {
      say("Enter the code from the email.", "error");
      return $("signinCode").focus();
    }
    const st = await busy($("btnVerify"), "Checking…", () => api("/api/cloud/verify", { email, code }));
    if (st) {
      show("stepPassword");
      say("Email confirmed.", "ok");
    }
  });
  $("btnResend").addEventListener("click", (ev) => sendCode(ev.currentTarget));
  $("btnCodeBack").addEventListener("click", () => {
    say("");
    show(mode === "reset" ? "stepResetEmail" : "stepDetails");
  });

  $("stepPassword").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    say("");
    if (!$("lateDetails").hidden) {
      const p = readProfile($("lateFirstName"), $("lateLastName"), $("lateUsername"));
      if (!p) return;
      profile = p;
    }
    if (!renderPassword()) {
      say("Your password doesn't meet all the requirements yet.", "error");
      return $("newPassword").focus();
    }
    const password = $("newPassword").value;
    if (password !== $("newPassword2").value) {
      say("The passwords don't match.", "error");
      return $("newPassword2").focus();
    }
    const body = profile ? { password, ...profile } : { password };
    const label = mode === "reset" ? "Saving…" : "Creating your account…";
    const st = await busy($("btnSavePassword"), label, () => api("/api/cloud/set-password", body));
    if (st) return enterApp(st);
    // Someone took the username in the meantime: let it be changed right here.
    if (profile && currentUsernameInput().getAttribute("aria-invalid") === "true" && $("lateDetails").hidden) {
      $("lateFirstName").value = profile.first_name;
      $("lateLastName").value = profile.last_name;
      $("lateUsername").value = profile.username;
      $("lateDetails").hidden = false;
      flagUsername($("lateUsername"), "taken");
      $("lateUsername").focus();
    }
  });

  $("btnCancelPending").addEventListener("click", async (ev) => {
    if (await busy(ev.currentTarget, "…", () => api("/api/cloud/cancel"))) {
      clearDraft();
      email = "";
      profile = null;
      mode = "signin";
      $("signinEmail").value = "";
      show("stepSignin");
    }
  });

  /* ---------- start ---------- */

  // Came back after the code but before choosing a password: pick up there.
  const root = $("signin");
  const pendingEmail = root.dataset.pendingEmail;
  if (pendingEmail) {
    email = pendingEmail;
    const draft = loadDraft();
    if (draft && draft.email === pendingEmail && draft.profile) {
      mode = "new";
      profile = draft.profile;
    } else {
      // No details to hand: a reset (the account has them) or a new account
      // whose details were lost when the window closed (ask again).
      mode = root.dataset.pendingProfile ? "reset" : "new";
      $("lateDetails").hidden = Boolean(root.dataset.pendingProfile);
    }
    show("stepPassword");
    $("signinKicker").textContent = "Almost done";
    $("signinLede").textContent = `${pendingEmail} is confirmed. Choose a password to finish.`;
  } else {
    show("stepSignin");
  }
})();
