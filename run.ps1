# Run ansem.io tracker with portable Node if system Node isn't on PATH
$portable = Join-Path $env:LOCALAPPDATA "nodejs-portable\node-v24.19.0-win-x64"
if (Test-Path (Join-Path $portable "node.exe")) {
  $env:Path = "$portable;" + $env:Path
}

Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js not found. Install Node LTS or keep the portable copy under $portable"
  exit 1
}

$mode = if ($args.Count -gt 0) { $args[0] } else { "track" }

switch ($mode) {
  "setup" { npm run setup }
  "track" { npm run track }
  default {
    Write-Host "Usage: .\run.ps1 [setup|track]"
    exit 1
  }
}
