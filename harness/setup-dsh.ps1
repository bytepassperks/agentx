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

# ---- NVIDIA key ----
$Key = $env:NVIDIA_API_KEY
$EnvFile = Join-Path $Home_ ".env"
if (-not $Key -and (Test-Path $EnvFile)) {
    $m = Select-String -Path $EnvFile -Pattern '^NVIDIA_API_KEY=(.+)$' | Select-Object -First 1
    if ($m) { $Key = $m.Matches[0].Groups[1].Value }
}
if (-not $Key) {
    Write-Host "  Get a free key at https://build.nvidia.com/settings/api-keys" -ForegroundColor Cyan
    $Key = Read-Host "  NVIDIA API key (nvapi-...)"
}
if ($Key) {
    [IO.File]::WriteAllText($EnvFile, "NVIDIA_API_KEY=$Key`r`n", (New-Object Text.UTF8Encoding $false))
    Write-Host "  + key saved to $EnvFile" -ForegroundColor Green
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

# ---- launcher ----
$Launcher = Join-Path $Root "dsh.cmd"
@"
@echo off
set "DSH_HOME=$Home_"
set "PATH=$NodeDir;$NpmDir;%PATH%"
set "npm_config_prefix=$NpmDir"
set "npm_config_cache=$NpmCache"
set "DSH_TELEMETRY_MODE=DISABLED"
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
