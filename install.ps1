# Muhurata Focus Timer — one-line installer / updater for Windows.
#
#   irm https://raw.githubusercontent.com/Harsh-0024/Pomodoro-timer/main/install.ps1 | iex
#
# Installs into %USERPROFILE%\MuhurataTimer (override with $env:MUHURATA_DIR),
# writes a "Muhurata Timer" shortcut on the Desktop, and starts the app.
# Running the same line again updates an existing install.
$ErrorActionPreference = "Stop"

$RepoUrl    = if ($env:MUHURATA_REPO) { $env:MUHURATA_REPO } else { "https://github.com/Harsh-0024/Pomodoro-timer.git" }
$InstallDir = if ($env:MUHURATA_DIR) { $env:MUHURATA_DIR } else { Join-Path $HOME "MuhurataTimer" }
$MinPy      = [version]"3.9"

function Say($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
# throw (not exit): under "irm | iex" an exit would close the whole console window.
function Fail($msg) { throw "Error: $msg" }

# ---------------------------------------------------------------- prerequisites
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git is not installed. Install it from https://git-scm.com/download/win (or run: winget install Git.Git), then paste the install command again."
}

# Prefer the 'py' launcher: a bare 'python' on a fresh Windows opens the Microsoft Store.
$PyExe = $null; $PyArgs = @(); $verStr = $null
foreach ($cand in @("py -3", "python", "python3")) {
    $parts = $cand -split " "
    $exe = $parts[0]; $extra = @($parts | Select-Object -Skip 1)
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    try {
        $out = & $exe @extra -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($LASTEXITCODE -eq 0 -and $out -and ([version]$out -ge $MinPy)) {
            $PyExe = $exe; $PyArgs = $extra; $verStr = $out; break
        }
    } catch { }
}
if (-not $PyExe) {
    Fail "Python $MinPy or newer is required. Install from https://python.org/downloads (tick 'Add python.exe to PATH'), then paste the install command again."
}
Say "Using Python $verStr ($PyExe $PyArgs)"

# ---------------------------------------------------------------- clone / update
if (Test-Path (Join-Path $InstallDir ".git")) {
    Say "Updating existing install in $InstallDir"
    git -C $InstallDir fetch --quiet origin
    git -C $InstallDir reset --hard --quiet origin/main
} else {
    Say "Downloading Muhurata into $InstallDir"
    git clone --quiet $RepoUrl $InstallDir
}
Set-Location $InstallDir

# ---------------------------------------------------------------- virtualenv
$VenvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
if (-not (Test-Path $VenvPy)) {
    Say "Creating Python environment"
    & $PyExe @PyArgs -m venv .venv
    if ($LASTEXITCODE -ne 0) { Fail "Could not create a virtualenv." }
}
# Packages themselves are installed by run.py (only when requirements change).

# ---------------------------------------------------------------- launcher
$Bat = Join-Path $InstallDir "Muhurata Timer.bat"
@"
@echo off
cd /d "$InstallDir"
".venv\Scripts\python.exe" run.py
if errorlevel 1 pause
"@ | Set-Content -Path $Bat -Encoding Oem

$Desktop = [Environment]::GetFolderPath("Desktop")
if (Test-Path $Desktop) {
    $Shell = New-Object -ComObject WScript.Shell
    $Lnk = $Shell.CreateShortcut((Join-Path $Desktop "Muhurata Timer.lnk"))
    $Lnk.TargetPath = $Bat
    $Lnk.WorkingDirectory = $InstallDir
    $Lnk.Description = "Muhurata Focus Timer"
    $Lnk.Save()
    Say "Shortcut placed on your Desktop: 'Muhurata Timer' (double-click it next time)"
}

# ---------------------------------------------------------------- run
Say "Starting Muhurata (first start installs packages, ~1 minute)..."
& $VenvPy run.py
