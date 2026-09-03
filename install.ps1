# agentx installer for Windows
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/bytepassperks/agentx/main/install.ps1 | iex
# Optional, before running:  $env:AGENTX_TOKEN="..."; $env:AGENTX_BASE_URL="https://..."; $env:AGENTX_GITHUB_TOKEN="ghp_..."

$ErrorActionPreference = "Stop"
$Repo = "bytepassperks/agentx"
$InstallDir = Join-Path $env:LOCALAPPDATA "agentx"
$Exe = Join-Path $InstallDir "agentx.exe"
$ConfigDir = Join-Path $env:USERPROFILE ".agentx"
$ConfigPath = Join-Path $ConfigDir "config.json"

function Write-Step($m) { Write-Host "  > $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "  + $m" -ForegroundColor Green }

Write-Host ""
Write-Host "  agentx installer" -ForegroundColor Magenta
Write-Host ""

if ($PSVersionTable.PSVersion.Major -lt 5) { throw "PowerShell 5+ required" }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# --- download latest release ---
$Version = if ($env:AGENTX_VERSION) { $env:AGENTX_VERSION } else { "latest" }
$Url = if ($Version -eq "latest") { "https://github.com/$Repo/releases/latest/download/agentx.exe" } else { "https://github.com/$Repo/releases/download/$Version/agentx.exe" }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$tmp = "$Exe.download"
Write-Step "Downloading agentx ($Version)..."
$ProgressPreference = "SilentlyContinue"
Invoke-WebRequest $Url -OutFile $tmp -UseBasicParsing
$old = "$Exe.old"
if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
if (Test-Path $Exe) {
    # A running exe cannot be deleted on Windows, but it can be renamed.
    try { Remove-Item $Exe -Force -ErrorAction Stop } catch { Move-Item $Exe $old -Force }
}
Move-Item $tmp $Exe -Force
Write-Ok "Installed to $Exe"

# --- PATH ---
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not ($userPath -split ";" | Where-Object { $_ -eq $InstallDir })) {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
    Write-Ok "Added to user PATH"
}
if (-not ($env:Path -split ";" | Where-Object { $_ -eq $InstallDir })) { $env:Path += ";$InstallDir" }

# --- config ---
New-Item -ItemType Directory -Force -Path $ConfigDir | Out-Null
$cfg = @{}
if (Test-Path $ConfigPath) {
    try { ((Get-Content $ConfigPath -Raw) -replace '^\xEF\xBB\xBF|^\uFEFF','' | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value } } catch {}
}

# provider: env var > existing config > NVIDIA default (free at build.nvidia.com)
$NvidiaUrl = "https://integrate.api.nvidia.com"
$OldProxy = "https://claudemax-v4.pages.dev"
if ($env:AGENTX_BASE_URL) { $cfg.baseUrl = $env:AGENTX_BASE_URL; $cfg.Remove("provider") }
if (-not $cfg.baseUrl -or $cfg.baseUrl -eq $OldProxy) {
    # fresh install, or migrating off the dead proxy
    if ($cfg.baseUrl -eq $OldProxy) { Write-Host "  ! old proxy $OldProxy no longer works; switching to NVIDIA" -ForegroundColor Yellow; $cfg.Remove("authToken") }
    $cfg.baseUrl = $NvidiaUrl
    $cfg.provider = "openai"
    if (-not $env:AGENTX_MODEL -and (-not $cfg.model -or "$($cfg.model)".StartsWith("claude"))) { $cfg.model = "nvidia/nemotron-3-super-120b-a12b" }
}
if ($cfg.model -eq "openai/gpt-oss-120b") { Write-Host "  ! NVIDIA retired openai/gpt-oss-120b; switching model to nvidia/nemotron-3-super-120b-a12b" -ForegroundColor Yellow; $cfg.model = "nvidia/nemotron-3-super-120b-a12b" }
if ($env:AGENTX_PROVIDER) { $cfg.provider = $env:AGENTX_PROVIDER }
if ($env:AGENTX_TOKEN) { $cfg.authToken = $env:AGENTX_TOKEN }
if ($env:AGENTX_GITHUB_TOKEN) { $cfg.githubToken = $env:AGENTX_GITHUB_TOKEN }
if ($env:AGENTX_MODEL) { $cfg.model = $env:AGENTX_MODEL }

$Interactive = [Environment]::UserInteractive -and -not $env:AGENTX_NO_LAUNCH
try { $null = $Host.UI.RawUI.KeyAvailable } catch { $Interactive = $false }
if (-not $cfg.authToken) {
    if ($cfg.baseUrl -eq $NvidiaUrl) { Write-Host "  Get a free NVIDIA key at https://build.nvidia.com/settings/api-keys" -ForegroundColor Cyan }
    if ($Interactive) {
        $t = Read-Host "  API key (Enter to set later in Settings)"
        if ($t) { $cfg.authToken = $t }
    } else {
        Write-Host "  Set your key later: agentx config --token <key>   (or in the app's Settings)" -ForegroundColor Yellow
    }
}
if (-not $cfg.githubToken -and $Interactive) {
    $g = Read-Host "  GitHub token for PRs/push (Enter to skip)"
    if ($g) { $cfg.githubToken = $g }
}

[IO.File]::WriteAllText($ConfigPath, ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
Write-Ok "Config written to $ConfigPath"

# --- Start Menu + Desktop shortcuts (GUI, no console window) ---
try {
    $ws = New-Object -ComObject WScript.Shell
    $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
    $lnkArgs = "-NoProfile -WindowStyle Hidden -Command `"Start-Process -FilePath '$Exe' -WindowStyle Hidden -WorkingDirectory `$env:USERPROFILE`""
    $targets = @(
        (Join-Path ([Environment]::GetFolderPath("Programs")) "agentx.lnk"),
        (Join-Path ([Environment]::GetFolderPath("Desktop")) "agentx.lnk")
    )
    foreach ($lnkPath in $targets) {
        $lnk = $ws.CreateShortcut($lnkPath)
        $lnk.TargetPath = $ps
        $lnk.Arguments = $lnkArgs
        $lnk.WorkingDirectory = $env:USERPROFILE
        $lnk.IconLocation = "$Exe,0"
        $lnk.Description = "agentx - autonomous coding agent"
        $lnk.Save()
    }
    Write-Ok "Shortcuts added to Start Menu and Desktop"
} catch { Write-Host "  ! could not create shortcuts: $_" -ForegroundColor Yellow }

# --- git identity (needed for commits) ---
if (Get-Command git -ErrorAction SilentlyContinue) {
    if (-not (git config --global user.name)) { git config --global user.name "agentx" }
    if (-not (git config --global user.email)) { git config --global user.email "agentx@localhost" }
} else {
    Write-Host "  ! git not found. Install: winget install Git.Git" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Done. Launch 'agentx' from the Start Menu / Desktop, or run  agentx  in a project folder." -ForegroundColor Green
Write-Host "  Terminal mode:  agentx --cli      One-shot:  agentx `"fix the failing tests`"" -ForegroundColor Gray
Write-Host ""

if ($env:AGENTX_NO_LAUNCH -ne "1") { Start-Process -FilePath $Exe -WorkingDirectory $env:USERPROFILE }
