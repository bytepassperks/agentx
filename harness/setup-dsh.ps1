# DeepSeek Harness (dsh) portable setup — everything lives under $Root (default D:\Harness).
# Nothing is written to C:\ : portable Node.js, npm prefix/cache, DSH_HOME, workspace all sit under $Root.
#
#   $env:NVIDIA_API_KEY="nvapi-..."; irm "https://raw.githubusercontent.com/bytepassperks/agentx/main/harness/setup-dsh.ps1" | iex
#
# Optional env: DSH_ROOT (default D:\Harness), DSH_MODEL (default openai/gpt-oss-120b), DSH_NO_LAUNCH=1

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = if ($env:DSH_ROOT) { $env:DSH_ROOT } else { "D:\Harness" }
$Model = if ($env:DSH_MODEL) { $env:DSH_MODEL } else { "openai/gpt-oss-120b" }
$NodeDir = Join-Path $Root "node"
$NpmDir = Join-Path $Root "npm"
$NpmCache = Join-Path $Root "npm-cache"
$Home_ = Join-Path $Root "home"
$Workspace = Join-Path $Root "workspace"

Write-Host ""
Write-Host "  DeepSeek Harness portable setup -> $Root" -ForegroundColor Cyan
Write-Host ""

foreach ($d in @($Root, $NpmDir, $NpmCache, $Home_, $Workspace)) {
    if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# ---- portable Node.js (LTS, win-x64 zip) ----
$NodeExe = Join-Path $NodeDir "node.exe"
if (-not (Test-Path $NodeExe)) {
    Write-Host "  > Downloading portable Node.js LTS..."
    $index = Invoke-RestMethod "https://nodejs.org/dist/index.json"
    $lts = $index | Where-Object { $_.lts -and ($_.files -contains "win-x64-zip") } | Select-Object -First 1
    $ver = $lts.version
    $zip = Join-Path $Root "node-$ver-win-x64.zip"
    Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip
    $tmp = Join-Path $Root "_node_extract"
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip -DestinationPath $tmp -Force
    if (Test-Path $NodeDir) { Remove-Item $NodeDir -Recurse -Force }
    Move-Item (Join-Path $tmp "node-$ver-win-x64") $NodeDir
    Remove-Item $tmp -Recurse -Force
    Remove-Item $zip -Force
    Write-Host "  + Node.js $ver -> $NodeDir" -ForegroundColor Green
} else {
    Write-Host "  + Node.js already present: $(& $NodeExe -v)" -ForegroundColor Green
}

# keep npm entirely inside $Root
$env:PATH = "$NodeDir;$NpmDir;$env:PATH"
$env:npm_config_prefix = $NpmDir
$env:npm_config_cache = $NpmCache
$env:npm_config_update_notifier = "false"
$env:npm_config_fund = "false"
$env:npm_config_audit = "false"

# ---- dsh ----
Write-Host "  > Installing @deepseek-ai/dsh (this takes a few minutes)..."
& (Join-Path $NodeDir "npm.cmd") install -g @deepseek-ai/dsh --loglevel=error
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
Write-Host "  + dsh installed -> $NpmDir" -ForegroundColor Green

# ---- keys (.env under D:\Harness\home; one KEY=value per line) ----
$EnvFile = Join-Path $Home_ ".env"
function Read-EnvKey($name) {
    if (-not (Test-Path $EnvFile)) { return $null }
    $m = Select-String -Path $EnvFile -Pattern "^$name=(.+)$" | Select-Object -First 1
    if ($m) { $m.Matches[0].Groups[1].Value.Trim() } else { $null }
}
function Write-EnvKey($name, $value) {
    $lines = @()
    if (Test-Path $EnvFile) { $lines = [IO.File]::ReadAllLines($EnvFile) | Where-Object { $_ -notmatch "^$name=" -and $_ -ne '' } }
    $lines += "$name=$value"
    [IO.File]::WriteAllText($EnvFile, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
}

# ---- NVIDIA key ----
$Key = $env:NVIDIA_API_KEY
if (-not $Key) { $Key = Read-EnvKey 'NVIDIA_API_KEY' }
if (-not $Key) {
    Write-Host "  Get a free key at https://build.nvidia.com/settings/api-keys" -ForegroundColor Cyan
    $Key = Read-Host "  NVIDIA API key (nvapi-...)"
}
if ($Key) {
    $Key = $Key.Trim().Trim('"', "'", '<', '>')
    # dsh only accepts printable ASCII (no spaces, no unicode) in the key
    if ($Key -notmatch '^nvapi-[\x21-\x7E]+$') {
        $bad = ([char[]]$Key | Where-Object { [int]$_ -lt 33 -or [int]$_ -gt 126 } | ForEach-Object { 'U+{0:X4}' -f [int]$_ } | Select-Object -Unique) -join ' '
        throw "NVIDIA_API_KEY is not a raw nvapi-... key (bad characters: $bad). Copy the key alone from https://build.nvidia.com/settings/api-keys and re-run."
    }
    $env:NVIDIA_API_KEY = $Key
    Write-EnvKey 'NVIDIA_API_KEY' $Key
    Write-Host "  + NVIDIA key saved to $EnvFile" -ForegroundColor Green
}

# ---- Exa key (web_search) ----
$ExaKey = $env:EXA_API_KEY
if (-not $ExaKey) { $ExaKey = Read-EnvKey 'EXA_API_KEY' }
$Interactive = [Environment]::UserInteractive
try { $null = $Host.UI.RawUI.KeyAvailable } catch { $Interactive = $false }
if (-not $ExaKey -and $Interactive) {
    Write-Host "  Optional: Exa key for web_search (free tier at https://dashboard.exa.ai)" -ForegroundColor Cyan
    $ExaKey = Read-Host "  EXA API key (Enter to skip)"
}
if ($ExaKey) {
    $ExaKey = $ExaKey.Trim().Trim('"', "'", '<', '>')
    if ($ExaKey -notmatch '^[\x21-\x7E]+$') { throw "EXA_API_KEY contains characters that cannot go in an HTTP header; paste the raw key alone." }
    $env:EXA_API_KEY = $ExaKey
    Write-EnvKey 'EXA_API_KEY' $ExaKey
    Write-Host "  + Exa key saved to $EnvFile" -ForegroundColor Green
}
# a stale key in dsh's managed store would override .env - drop it
$CredFile = Join-Path $Home_ ".credentials.yaml"
if ((Test-Path $CredFile) -and (Select-String -Path $CredFile -Pattern 'NVIDIA_API_KEY' -Quiet)) {
    Remove-Item $CredFile -Force
    Write-Host "  + removed stale $CredFile" -ForegroundColor Yellow
}

# ---- provider config (NVIDIA, OpenAI-compatible) ----
$Settings = Join-Path $Home_ "settings.yaml"
if (-not (Test-Path $Settings) -or -not (Select-String -Path $Settings -Pattern "nvidia:" -Quiet)) {
    $yaml = @"
llm-pi-ai:
  providers:
    nvidia:
      displayName: NVIDIA (build.nvidia.com)
      apiKeyEnv: NVIDIA_API_KEY
      api: openai-completions
      baseURL: https://integrate.api.nvidia.com/v1
      compat:
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: $Model
        - id: nvidia/nemotron-3-super-120b-a12b
        - id: nvidia/nemotron-3-ultra-550b-a55b
        - id: deepseek-ai/deepseek-v4-pro-0813
        - id: deepseek-ai/deepseek-v4-flash-0731
        - id: moonshotai/kimi-k3
agent-default-model:
  provider: nvidia
  model: $Model
"@
    if (Test-Path $Settings) { $yaml = (Get-Content $Settings -Raw) + "`r`n" + $yaml }
    [IO.File]::WriteAllText($Settings, $yaml, (New-Object Text.UTF8Encoding $false))
    Write-Host "  + NVIDIA provider written to $Settings" -ForegroundColor Green
}

# ---- web_search via Exa (dsh plugin, per profile) ----
$ExaPatch = @"
# web_search -> Exa (key from EXA_API_KEY in `$DSH_HOME\.env); DeepSeek search disabled
- id: web
  config:
    searchProvider: exa
    fetchProvider: http
- id: web-search-deepseek
  disabled: true
- insert:
    - id: web-search-exa
      name: '@deepseek-ai/dsh-web-search-exa'
      config:
        apiKey: !!js process.env.EXA_API_KEY
"@
if ($ExaKey) {
    $env:DSH_HOME = $Home_
    $env:DSH_TELEMETRY_MODE = "DISABLED"
    $DshVersion = (& (Join-Path $NodeDir "npm.cmd") ls -g @deepseek-ai/dsh --depth=0 --json | ConvertFrom-Json).dependencies.'@deepseek-ai/dsh'.version
    foreach ($p in @('web', 'headless')) {
        $ProfileDir = Join-Path $Home_ "profiles\$p"
        # first run creates the profile directory from dsh's shipped template
        if (-not (Test-Path (Join-Path $ProfileDir "package.json"))) {
            & (Join-Path $NpmDir "dsh.cmd") --profile $p --help *> $null
        }
        if (-not (Test-Path (Join-Path $ProfileDir "package.json"))) { throw "dsh did not create profile '$p' under $ProfileDir" }
        Push-Location $ProfileDir
        # --legacy-peer-deps: the plugin's peers (dsh-web, cordis) resolve from dsh's own install via profiles\node_modules
        & (Join-Path $NodeDir "npm.cmd") install --legacy-peer-deps --no-package-lock --loglevel=error "@deepseek-ai/dsh-web-search-exa@$DshVersion"
        $rc = $LASTEXITCODE
        Pop-Location
        if ($rc -ne 0) { throw "npm install of @deepseek-ai/dsh-web-search-exa failed in $ProfileDir" }
        [IO.File]::WriteAllText((Join-Path $ProfileDir "cordis.patch.yml"), $ExaPatch, (New-Object Text.UTF8Encoding $false))
    }
    Write-Host "  + web_search -> Exa (profiles: web, headless)" -ForegroundColor Green
} else {
    Write-Host "  ! no EXA_API_KEY: web_search stays on DeepSeek search (needs DEEPSEEK_API_KEY) - set `$env:EXA_API_KEY and re-run to switch" -ForegroundColor Yellow
}

# ---- launcher ----
$Launcher = Join-Path $Root "dsh.cmd"
@"
@echo off
set "DSH_HOME=$Home_"
set "PATH=$NodeDir;$NpmDir;%PATH%"
set "npm_config_prefix=$NpmDir"
set "npm_config_cache=$NpmCache"
set "DSH_TELEMETRY_MODE=DISABLED"
rem keys in .env always win over whatever this shell inherited
for /f "usebackq tokens=1,* delims==" %%A in ("$Home_\.env") do (
  if /i "%%A"=="NVIDIA_API_KEY" set "NVIDIA_API_KEY=%%B"
  if /i "%%A"=="EXA_API_KEY" set "EXA_API_KEY=%%B"
)
if "%~1"=="" (
  cd /d "$Workspace"
  "$NpmDir\dsh.cmd" web
) else (
  "$NpmDir\dsh.cmd" %*
)
"@ | Set-Content -Path $Launcher -Encoding ASCII
Write-Host "  + launcher -> $Launcher" -ForegroundColor Green

Write-Host ""
Write-Host "  Done. Start the Web UI (opens http://127.0.0.1:3080):" -ForegroundColor Cyan
Write-Host "    $Launcher"
Write-Host "  Workspace folder: $Workspace   (put/clone your repos there, or pick any folder in the UI)"
Write-Host "  Pick model 'nvidia / $Model' in the composer's model picker."
Write-Host ""

if (-not $env:DSH_NO_LAUNCH) { Start-Process -FilePath $Launcher -WorkingDirectory $Workspace }
