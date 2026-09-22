#!/usr/bin/env bash
# Muhurata Focus Timer — one-line installer / updater for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Harsh-0024/Pomodoro-timer/main/install.sh | bash
#
# Installs into ~/MuhurataTimer (override with MUHURATA_DIR), writes a
# double-clickable launcher on the Desktop, and starts the app. Running the
# same line again updates an existing install.
set -euo pipefail

REPO_URL="${MUHURATA_REPO:-https://github.com/Harsh-0024/Pomodoro-timer.git}"
INSTALL_DIR="${MUHURATA_DIR:-$HOME/MuhurataTimer}"
MIN_PY="3.9"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mError:\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- prerequisites
if [[ "$(uname -s)" == "Darwin" ]] && ! xcode-select -p >/dev/null 2>&1; then
  say "macOS needs the Command Line Tools (gives you git + python3). Opening the installer..."
  xcode-select --install || true
  fail "Finish the Command Line Tools install in the window that opened, then paste the install command again."
fi

command -v git >/dev/null 2>&1 || fail "git is not installed. macOS: run 'xcode-select --install'. Debian/Ubuntu: 'sudo apt install git'."

PY=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 &&
     "$candidate" -c "import sys; sys.exit(0 if sys.version_info >= tuple(map(int, '$MIN_PY'.split('.'))) else 1)" 2>/dev/null; then
    PY="$(command -v "$candidate")"; break
  fi
done
[[ -n "$PY" ]] || fail "Python $MIN_PY or newer is required. macOS: 'xcode-select --install' or https://python.org/downloads. Debian/Ubuntu: 'sudo apt install python3 python3-venv'."
say "Using $("$PY" --version) at $PY"

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

# ---------------------------------------------------------------- virtualenv
if [[ ! -x ".venv/bin/python" ]]; then
  say "Creating Python environment"
  "$PY" -m venv .venv || fail "Could not create a virtualenv. Debian/Ubuntu: 'sudo apt install python3-venv' and retry."
fi
# Packages themselves are installed by run.py (only when requirements change).

# ---------------------------------------------------------------- launcher
LAUNCHER="$INSTALL_DIR/Muhurata Timer.command"
cat > "$LAUNCHER" <<LAUNCH
#!/usr/bin/env bash
cd "$INSTALL_DIR" && exec ".venv/bin/python" run.py
LAUNCH
chmod +x "$LAUNCHER"
if [[ -d "$HOME/Desktop" ]]; then
  cp "$LAUNCHER" "$HOME/Desktop/Muhurata Timer.command"
  chmod +x "$HOME/Desktop/Muhurata Timer.command"
  say "Launcher placed on your Desktop: 'Muhurata Timer.command' (double-click it next time)"
fi

# ---------------------------------------------------------------- run
say "Starting Muhurata (first start installs packages, ~1 minute)..."
# Reattach stdin to the terminal (we were piped from curl) so Ctrl+C / prompts work.
if { : </dev/tty; } 2>/dev/null; then
  exec ".venv/bin/python" run.py "$@" </dev/tty
else
  exec ".venv/bin/python" run.py "$@"
fi
