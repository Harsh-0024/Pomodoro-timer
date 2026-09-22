#!/usr/bin/env bash
# Muhurata Focus Timer — one-line installer / updater for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Harsh-0024/Pomodoro-timer/main/install.sh | bash
#
# Installs into ~/MuhurataTimer (override with MUHURATA_DIR), writes a
# double-clickable launcher on the Desktop, and starts the app. Running the
# same line again updates an existing install.
#
# Python is not assumed to exist: uv fetches the exact version pinned in
# .python-version, so every install runs the same interpreter regardless of
# what the machine happens to have. A usable system Python is only a fallback
# for when uv cannot be reached.
set -euo pipefail

REPO_URL="${MUHURATA_REPO:-https://github.com/Harsh-0024/Pomodoro-timer.git}"
INSTALL_DIR="${MUHURATA_DIR:-$HOME/MuhurataTimer}"
UV_DIR="$HOME/.muhurata/bin"
FALLBACK_MIN_PY="3.9"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- prerequisites
if [[ "$(uname -s)" == "Darwin" ]] && ! xcode-select -p >/dev/null 2>&1; then
  say "macOS needs the Command Line Tools (this gives you git). Opening the installer..."
  xcode-select --install || true
  fail "Finish the Command Line Tools install in the window that opened, then paste the install command again."
fi

command -v git >/dev/null 2>&1 || fail "git is not installed. macOS: run 'xcode-select --install'. Debian/Ubuntu: 'sudo apt install git'."

# ---------------------------------------------------------------- clone / update
if [[ -d "$INSTALL_DIR/.git" ]]; then
  say "Updating existing install in $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --quiet origin
  git -C "$INSTALL_DIR" reset --hard --quiet origin/main
else
  say "Downloading Muhurata into $INSTALL_DIR"
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi
cd "$INSTALL_DIR"

WANT_PY="$(tr -d '[:space:]' < .python-version 2>/dev/null || echo '')"
[[ -n "$WANT_PY" ]] || WANT_PY="3.12"

# ---------------------------------------------------------------- uv
find_uv() {
  if [[ -x "$UV_DIR/uv" ]]; then echo "$UV_DIR/uv"; return 0; fi
  command -v uv 2>/dev/null && return 0
  return 1
}

UV="$(find_uv || true)"
if [[ -z "$UV" ]]; then
  say "Setting up the Python toolchain (one-time, about 30 seconds)..."
  mkdir -p "$UV_DIR"
  if curl -fsSL https://astral.sh/uv/install.sh 2>/dev/null | env UV_UNMANAGED_INSTALL="$UV_DIR" sh >/dev/null 2>&1; then
    UV="$UV_DIR/uv"
  else
    warn "Could not fetch the Python toolchain; falling back to the Python already on this computer."
  fi
fi

# ---------------------------------------------------------------- virtualenv
build_venv_with_uv() {
  "$UV" python install "$WANT_PY" >/dev/null 2>&1 || true
  "$UV" venv --clear --seed --python "$WANT_PY" .venv >/dev/null 2>&1   # --seed: run.py needs pip inside
}

need_venv=1
if [[ -x ".venv/bin/python" ]]; then
  have="$(.venv/bin/python -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo '')"
  [[ "$have" == "$WANT_PY" ]] && need_venv=0
fi

if [[ $need_venv -eq 1 ]]; then
  rm -rf .venv
  if [[ -n "$UV" ]] && build_venv_with_uv; then
    say "Using Python $("$PWD/.venv/bin/python" --version 2>&1 | cut -d' ' -f2)"
  else
    # Fallback: whatever suitable Python this machine already has.
    PY=""
    for candidate in python3 python; do
      if command -v "$candidate" >/dev/null 2>&1 &&
         "$candidate" -c "import sys; sys.exit(0 if sys.version_info >= tuple(map(int, '$FALLBACK_MIN_PY'.split('.'))) else 1)" 2>/dev/null; then
        PY="$(command -v "$candidate")"; break
      fi
    done
    [[ -n "$PY" ]] || fail "Could not download Python, and this computer has no Python $FALLBACK_MIN_PY or newer. Check your internet connection and paste the install command again."
    warn "Using this computer's Python ($("$PY" --version 2>&1 | cut -d' ' -f2)) instead of $WANT_PY."
    "$PY" -m venv .venv || fail "Could not create a virtualenv. Debian/Ubuntu: 'sudo apt install python3-venv' and retry."
  fi
fi
# Packages themselves are installed by run.py (only when requirements change).

# ---------------------------------------------------------------- launcher
LAUNCHER="$INSTALL_DIR/Muhurata Timer.command"
cat > "$LAUNCHER" <<LAUNCH
#!/usr/bin/env bash
cd "$INSTALL_DIR" && exec ".venv/bin/python" run.py "\$@"
LAUNCH
chmod +x "$LAUNCHER"

if [[ -d "$HOME/Desktop" ]]; then
  if [[ "$(uname -s)" == "Darwin" ]]; then
    # A real .app bundle: proper name and icon in Finder and the Dock.
    bash "$INSTALL_DIR/packaging/make_macos_app.sh" "$INSTALL_DIR" "$HOME/Desktop"
    rm -f "$HOME/Desktop/Muhurata Timer.command"   # tidy up pre-.app installs
    say "App placed on your Desktop: 'Muhurata Timer' (double-click it next time)"
  else
    cp "$LAUNCHER" "$HOME/Desktop/Muhurata Timer.command"
    chmod +x "$HOME/Desktop/Muhurata Timer.command"
    say "Launcher placed on your Desktop: 'Muhurata Timer.command' (double-click it next time)"
  fi
fi

# ---------------------------------------------------------------- run
say "Starting Muhurata..."
# Reattach stdin to the terminal (we were piped from curl) so Ctrl+C / prompts work.
if { : </dev/tty; } 2>/dev/null; then
  exec ".venv/bin/python" run.py "$@" </dev/tty
else
  exec ".venv/bin/python" run.py "$@"
fi
