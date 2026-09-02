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
if (Test-Path $Exe) { Remove-Item $Exe -Force }
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
    try { (Get-Content $ConfigPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $cfg[$_.Name] = $_.Value } } catch {}
}

# token / base url: env var > existing config > ~/.claude/settings.json > prompt
$claude = Join-Path $env:USERPROFILE ".claude\settings.json"
$claudeEnv = $null
if (Test-Path $claude) { try { $claudeEnv = (Get-Content $claude -Raw | ConvertFrom-Json).env } catch {} }

if ($env:AGENTX_TOKEN) { $cfg.authToken = $env:AGENTX_TOKEN }
elseif (-not $cfg.authToken -and $claudeEnv.ANTHROPIC_AUTH_TOKEN) { $cfg.authToken = $claudeEnv.ANTHROPIC_AUTH_TOKEN }

if ($env:AGENTX_BASE_URL) { $cfg.baseUrl = $env:AGENTX_BASE_URL }
elseif (-not $cfg.baseUrl -and $claudeEnv.ANTHROPIC_BASE_URL) { $cfg.baseUrl = $claudeEnv.ANTHROPIC_BASE_URL }

if ($env:AGENTX_GITHUB_TOKEN) { $cfg.githubToken = $env:AGENTX_GITHUB_TOKEN }
if ($env:AGENTX_MODEL) { $cfg.model = $env:AGENTX_MODEL }

if (-not $cfg.authToken) {
    $cfg.authToken = Read-Host "  API token"
}
if (-not $cfg.baseUrl) { $cfg.baseUrl = "https://claudemax-v4.pages.dev" }
if (-not $cfg.githubToken) {
    $g = Read-Host "  GitHub token for PRs/push (Enter to skip)"
    if ($g) { $cfg.githubToken = $g }
}

[IO.File]::WriteAllText($ConfigPath, ($cfg | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
Write-Ok "Config written to $ConfigPath"

# --- git identity (needed for commits) ---
if (Get-Command git -ErrorAction SilentlyContinue) {
    if (-not (git config --global user.name)) { git config --global user.name "agentx" }
    if (-not (git config --global user.email)) { git config --global user.email "agentx@localhost" }
} else {
    Write-Host "  ! git not found. Install: winget install Git.Git" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "  Done. Open a NEW terminal in any project folder and run:  agentx" -ForegroundColor Green
Write-Host "  One-shot:  agentx `"fix the failing tests`"" -ForegroundColor Gray
Write-Host ""
