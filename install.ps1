# Muhurata Focus Timer — one-line installer / updater for Windows.
#
#   irm https://raw.githubusercontent.com/Harsh-0024/Pomodoro-timer/main/install.ps1 | iex
#
# Installs into %USERPROFILE%\MuhurataTimer (override with $env:MUHURATA_DIR),
# writes a "Muhurata Timer" shortcut on the Desktop, and starts the app.
# Running the same line again updates an existing install.
#
# Python is not assumed to exist: uv fetches the exact version pinned in
# .python-version, so every install runs the same interpreter regardless of
# what the machine happens to have. A usable system Python is only a fallback
# for when uv cannot be reached.
$ErrorActionPreference = "Stop"

$RepoUrl    = if ($env:MUHURATA_REPO) { $env:MUHURATA_REPO } else { "https://github.com/Harsh-0024/Pomodoro-timer.git" }
$InstallDir = if ($env:MUHURATA_DIR) { $env:MUHURATA_DIR } else { Join-Path $HOME "MuhurataTimer" }
$UvDir      = Join-Path $HOME ".muhurata\bin"
$FallbackMinPy = [version]"3.9"

function Say($msg)  { Write-Host "==> $msg" -ForegroundColor Cyan }
function Warn($msg) { Write-Host "==> $msg" -ForegroundColor Yellow }
# throw (not exit): under "irm | iex" an exit would close the whole console window.
function Fail($msg) { throw "Error: $msg" }

# ---------------------------------------------------------------- prerequisites
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "git is not installed. Install it from https://git-scm.com/download/win (or run: winget install Git.Git), then paste the install command again."
}

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

$WantPy = "3.12"
$pinFile = Join-Path $InstallDir ".python-version"
if (Test-Path $pinFile) {
    $pinned = (Get-Content $pinFile -Raw).Trim()
    if ($pinned) { $WantPy = $pinned }
}

# ---------------------------------------------------------------- uv
$Uv = $null
$localUv = Join-Path $UvDir "uv.exe"
if (Test-Path $localUv) {
    $Uv = $localUv
} elseif (Get-Command uv -ErrorAction SilentlyContinue) {
    $Uv = (Get-Command uv).Source
} else {
    Say "Setting up the Python toolchain (one-time, about 30 seconds)..."
    try {
        $env:UV_UNMANAGED_INSTALL = $UvDir
        Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
        if (Test-Path $localUv) { $Uv = $localUv }
    } catch {
        Warn "Could not fetch the Python toolchain; falling back to the Python already on this computer."
    } finally {
        Remove-Item Env:\UV_UNMANAGED_INSTALL -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------- virtualenv
$VenvPy = Join-Path $InstallDir ".venv\Scripts\python.exe"
$needVenv = $true
if (Test-Path $VenvPy) {
    $have = & $VenvPy -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($have -eq $WantPy) { $needVenv = $false }
}

if ($needVenv) {
    Remove-Item -Recurse -Force (Join-Path $InstallDir ".venv") -ErrorAction SilentlyContinue
    $built = $false
    if ($Uv) {
        & $Uv python install $WantPy 2>$null | Out-Null
        # --seed: run.py needs pip inside the environment
        & $Uv venv --clear --seed --python $WantPy .venv 2>$null | Out-Null
        $built = Test-Path $VenvPy
    }
    if (-not $built) {
        # Fallback: whatever suitable Python this machine already has.
        # Prefer the 'py' launcher: a bare 'python' on a fresh Windows opens the Microsoft Store.
        $PyExe = $null; $PyArgs = @(); $verStr = $null
        foreach ($cand in @("py -3", "python", "python3")) {
            $parts = $cand -split " "
            $exe = $parts[0]; $extra = @($parts | Select-Object -Skip 1)
            if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
            try {
                $out = & $exe @extra -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
                if ($LASTEXITCODE -eq 0 -and $out -and ([version]$out -ge $FallbackMinPy)) {
                    $PyExe = $exe; $PyArgs = $extra; $verStr = $out; break
                }
            } catch { }
        }
        if (-not $PyExe) {
            Fail "Could not download Python, and this computer has no Python $FallbackMinPy or newer. Check your internet connection and paste the install command again."
        }
        Warn "Using this computer's Python ($verStr) instead of $WantPy."
        & $PyExe @PyArgs -m venv .venv
        if (-not (Test-Path $VenvPy)) { Fail "Could not create a virtualenv." }
    } else {
        $built_ver = & $VenvPy -c "import sys; print('.'.join(map(str, sys.version_info[:3])))"
        Say "Using Python $built_ver"
    }
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
Say "Starting Muhurata..."
& $VenvPy run.py
