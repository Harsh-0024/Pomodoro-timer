(function () {
  "use strict";

  let audioCtx = null;

  const PROFILE_GAIN = { subtle: 0.45, balanced: 1, bold: 1.85 };

  function ensureCtx() {
    if (!audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) audioCtx = new AC();
    }
    if (audioCtx && audioCtx.state === "suspended") return audioCtx.resume();
    return Promise.resolve();
  }

  function masterGain(settings) {
    const vol = Number(settings?.sound_volume ?? 70) / 100;
    const profile = PROFILE_GAIN[settings?.sound_profile] ?? 1;
    return Math.min(1, vol * profile);
  }

  function tone(settings, freq, start, dur, vol, type) {
    if (!settings?.sound_enabled || !audioCtx) return;
    const g = masterGain(settings) * vol;
    if (g < 0.01) return;
    const t0 = audioCtx.currentTime + start;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(g, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.06);
  }

  function sequence(settings, notes) {
    if (!settings?.sound_enabled) return Promise.resolve();
    return ensureCtx().then(() => {
      notes.forEach(([freq, start, dur, vol, type]) =>
        tone(settings, freq, start, dur, vol, type || "sine")
      );
    });
  }

  window.FocusSounds = {
    prime(settings) {
      if (!settings?.sound_enabled) return Promise.resolve();
      return ensureCtx().then(() => tone(settings, 440, 0, 0.04, 0.2, "sine"));
    },

    workComplete(settings) {
      if (!settings?.chime_work_end) return;
      return sequence(settings, [
        [523.25, 0, 0.28, 0.22],
        [392.0, 0.14, 0.32, 0.18],
        [659.25, 0.32, 0.45, 0.16, "triangle"],
      ]);
    },

    breakComplete(settings) {
      if (!settings?.chime_break_end) return;
      return sequence(settings, [
        [659.25, 0, 0.22, 0.2],
        [880.0, 0.16, 0.38, 0.18],
        [1046.5, 0.38, 0.5, 0.14, "triangle"],
      ]);
    },

    tick(settings) {
      if (!settings?.tick_sound_enabled) return;
      return sequence(settings, [[880, 0, 0.06, 0.12]]);
    },

    start(settings) {
      if (!settings?.chime_session_start) return;
      return sequence(settings, [
        [392, 0, 0.12, 0.16],
        [523.25, 0.1, 0.22, 0.18],
      ]);
    },

    poolAdd(settings) {
      if (!settings?.chime_pool_add) return;
      return sequence(settings, [
        [349.23, 0, 0.14, 0.14],
        [440, 0.12, 0.2, 0.12],
      ]);
    },

    choice(settings) {
      if (!settings?.chime_choice) return;
      return sequence(settings, [[523.25, 0, 0.15, 0.14]]);
    },

    skip(settings) {
      if (!settings?.chime_skip) return;
      return sequence(settings, [[330, 0, 0.1, 0.12], [262, 0.08, 0.14, 0.1]]);
    },
  };
})();
