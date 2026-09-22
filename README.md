# Muhurata Focus Timer

A focus/pomodoro timer with a history dashboard. It runs on your own computer
(nothing is uploaded anywhere) and opens in your browser.

> 1 Muhurat = 48 min · 1 Ghadi = 24 min

## Install

Pick **one** of the two options. Both put your data in a private folder outside
the app, so updating never touches your history.

### Option A — one line in a terminal (needs git + Python 3.9+)

**macOS / Linux** — open *Terminal*, paste, press Enter:

```bash
curl -fsSL https://raw.githubusercontent.com/Harsh-0024/Pomodoro-timer/main/install.sh | bash
```

**Windows** — open *PowerShell*, paste, press Enter:

```powershell
irm https://raw.githubusercontent.com/Harsh-0024/Pomodoro-timer/main/install.ps1 | iex
```

What it does: downloads the app into `~/MuhurataTimer`, sets up Python
packages, puts a **Muhurata Timer** launcher on your Desktop, and starts the
app. From then on just double-click the launcher — it checks for updates
every time it starts, so you never need to update by hand.

Missing git or Python? macOS: run `xcode-select --install` (that gives you
both). Windows: [git](https://git-scm.com/download/win) and
[Python](https://python.org/downloads) (tick *Add python.exe to PATH*).

### Option B — download a ready-made app (no Python needed)

Grab the zip for your system from the
[latest release](https://github.com/Harsh-0024/Pomodoro-timer/releases/latest),
unzip it, and open the `Muhurata Timer` folder.

- **Windows:** double-click `Muhurata Timer.exe`. SmartScreen will say
  *Windows protected your PC* — click **More info → Run anyway** (first time
  only; the app isn't signed with a paid certificate, that's all).
- **macOS (Apple Silicon):** macOS blocks unsigned apps. Open *Terminal*,
  type `xattr -dr com.apple.quarantine ` (note the trailing space), drag the
  `Muhurata Timer` folder into the window, press Enter. Then double-click
  `Muhurata Timer` inside the folder. If you have Python anyway, Option A is
  smoother on a Mac.

To update, download the newer zip and replace the folder. Your data is kept.

## Using it

A terminal window shows `Muhurata is running at http://127.0.0.1:8000/` and
your browser opens. **Close that window (or press Ctrl+C) to stop the app.**

## Where's my data?

| | Path |
|---|---|
| macOS | `~/Library/Application Support/MuhurataTimer/` |
| Windows | `%LOCALAPPDATA%\MuhurataTimer\` |
| Linux | `~/.local/share/MuhurataTimer/` |

Inside: `focus_timer.db` (everything), `backups/` (automatic copies taken
before any database upgrade, newest 3 kept), `launcher.log`.

## Something's wrong?

Run the doctor and send the output along with `launcher.log`:

```bash
~/MuhurataTimer/.venv/bin/python ~/MuhurataTimer/run.py --doctor     # macOS / Linux
```

```powershell
& "$HOME\MuhurataTimer\.venv\Scripts\python.exe" "$HOME\MuhurataTimer\run.py" --doctor   # Windows
```

(For the zip version: run `Muhurata Timer --doctor` from inside the folder.)

---

## Development

```bash
git clone https://github.com/Harsh-0024/Pomodoro-timer.git && cd Pomodoro-timer
python3 -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
.venv/bin/python run.py --no-update      # or: python app.py (debug server on :8000)
```

**Schema changes** — edit `schema.py`, then generate a migration and review it
before committing (autogenerate can turn a rename into drop + add):

```bash
.venv/bin/python -m alembic revision --autogenerate -m "describe change"
```

Migrations apply automatically on the next start (a backup is taken first).

**Releases** — bump `version.py`, then:

```bash
git tag v1.0.1 && git push origin main v1.0.1
```

GitHub Actions builds the macOS and Windows bundles and attaches them to a
release. Local build: `pip install -r requirements-dev.txt && python -m PyInstaller muhurata.spec`.
