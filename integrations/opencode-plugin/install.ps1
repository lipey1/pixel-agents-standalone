# Copies the Pixel Agents lifecycle plugin into the OpenCode config directory.
# Usage:
#   powershell -ExecutionPolicy Bypass -File integrations\opencode-plugin\install.ps1
#   powershell -ExecutionPolicy Bypass -File integrations\opencode-plugin\install.ps1 -Repo "D:\code\pixel-agents-standalone" -Port 3456
param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [int]$Port = 3456,
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

$pluginDir = Join-Path $HOME ".config\opencode\plugins\pixel-agents"
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Copy-Item (Join-Path $PSScriptRoot "index.ts") (Join-Path $pluginDir "index.ts") -Force
Copy-Item (Join-Path $PSScriptRoot "gui-experimental.cjs") (Join-Path $pluginDir "gui-experimental.cjs") -Force

if (-not (Test-Path (Join-Path $Repo "dist\server.js"))) {
  Write-Warning "dist\server.js not found in $Repo. Run 'npm run build' before starting OpenCode."
}

if (-not $NodePath) {
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($node) { $NodePath = $node.Source }
}

$repoJson = $Repo.Replace("\", "\\")
$nodeJson = $NodePath.Replace("\", "\\")

Write-Host ""
Write-Host "Plugin copied to: $pluginDir"
Write-Host "Add this entry to the 'plugins' array in $HOME\.config\opencode\opencode.jsonc:"
Write-Host ""
Write-Host "  {"
Write-Host "    `"package`": `"./plugins/pixel-agents`","
Write-Host "    `"options`": {"
Write-Host "      `"repo`": `"$repoJson`","
Write-Host "      `"port`": $Port,"
if ($nodeJson) {
  Write-Host "      `"openBrowser`": true,"
  Write-Host "      `"nodePath`": `"$nodeJson`""
} else {
  Write-Host "      `"openBrowser`": true"
}
Write-Host "    }"
Write-Host "  }"
Write-Host ""
Write-Host "Then restart OpenCode Desktop. Logs: $env:LOCALAPPDATA\PixelAgents\plugin.log"
