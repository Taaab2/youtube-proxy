# YouTube Proxy - the actual updater. Run from %TEMP% (copied there by update.bat), so
# it can overwrite everything in the extension folder - including update.bat and itself
# - without a running file being modified under it. PowerShell loads the whole script
# into memory before executing, which is what makes overwriting boot.ps1 mid-run safe.
#
# It downloads the clean extension from the public code repo and copies it over the
# local folder, NEVER touching config.js (the personal token/repo/cookie key). config.js
# isn't in the repo at all, so it's never in the source - and it's explicitly skipped
# below as a second guard. No file in the destination is ever deleted.
param(
  [Parameter(Mandatory = $true)][string]$ExtDir
)

$ErrorActionPreference = "Stop"
# The update source is read from config.js (updateOwner/updateRepo), not hardcoded, so
# this script carries no personal identifier and the clean shareable copy stays clean.
$branch = "main"
# Create the work dir before anything logs — update.bat normally makes it, but boot.ps1
# must stand on its own (e.g. run directly), so don't assume it already exists.
$work = Join-Path $env:TEMP "ytproxy-upd"
New-Item -ItemType Directory -Force -Path $work | Out-Null
$log = Join-Path $work "update.log"

function Log($m) {
  $line = ("[{0}] {1}" -f (Get-Date -Format "HH:mm:ss"), $m)
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  Write-Host $line
}

try {
  Set-Content -LiteralPath $log -Value "" -Encoding UTF8
  Log "updating: $ExtDir"

  if (-not (Test-Path -LiteralPath (Join-Path $ExtDir "manifest.json"))) {
    throw "target does not look like the extension folder (no manifest.json): $ExtDir"
  }

  # Read the update source from the local config.js (never overwritten by updates).
  $cfgPath = Join-Path $ExtDir "config.js"
  if (-not (Test-Path -LiteralPath $cfgPath)) {
    throw "config.js not found - set up the extension first"
  }
  $cfgText = Get-Content -LiteralPath $cfgPath -Raw
  $mOwner = [regex]::Match($cfgText, 'updateOwner:\s*"([^"]*)"')
  $mRepo  = [regex]::Match($cfgText, 'updateRepo:\s*"([^"]*)"')
  $owner = $mOwner.Groups[1].Value
  $repo  = $mRepo.Groups[1].Value
  if (-not $owner -or -not $repo) {
    throw "no update source in config.js (updateOwner/updateRepo are empty)"
  }
  Log "update source: $owner/$repo"

  $zip  = Join-Path $work "src.zip"
  $ex   = Join-Path $work "extract"
  if (Test-Path -LiteralPath $ex) { Remove-Item -LiteralPath $ex -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $ex | Out-Null

  $url = "https://github.com/$owner/$repo/archive/refs/heads/$branch.zip"
  Log "downloading $url"
  # TLS 1.2 for older Windows PowerShell defaults
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

  Log "extracting"
  Expand-Archive -LiteralPath $zip -DestinationPath $ex -Force

  $src = Join-Path $ex "$repo-$branch\extension"
  if (-not (Test-Path -LiteralPath (Join-Path $src "manifest.json"))) {
    throw "downloaded archive has no extension/manifest.json - aborting so nothing is overwritten"
  }

  # Back up config.js just in case, then copy everything except it.
  $cfg = Join-Path $ExtDir "config.js"
  $cfgBak = $null
  if (Test-Path -LiteralPath $cfg) {
    $cfgBak = Join-Path $work "config.js.bak"
    Copy-Item -LiteralPath $cfg -Destination $cfgBak -Force
    Log "backed up config.js"
  }

  $srcFull = (Resolve-Path -LiteralPath $src).Path
  $copied = 0
  Get-ChildItem -LiteralPath $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($srcFull.Length).TrimStart("\", "/")
    if ($rel -ieq "config.js") { return }            # never overwrite the user's config
    if ($rel -ieq "config.example.js") { return }    # not needed in a live install
    $dest = Join-Path $ExtDir $rel
    $destDir = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destDir)) { New-Item -ItemType Directory -Force -Path $destDir | Out-Null }
    Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
    $copied++
  }
  Log "copied $copied files"

  # Restore config.js if anything went sideways (defensive; it should be untouched).
  if ($cfgBak -and -not (Test-Path -LiteralPath $cfg)) {
    Copy-Item -LiteralPath $cfgBak -Destination $cfg -Force
    Log "restored config.js from backup"
  }

  $newVer = (Get-Content -LiteralPath (Join-Path $ExtDir "manifest.json") -Raw | ConvertFrom-Json).version
  Log "done - now at version $newVer"
  exit 0
}
catch {
  Log ("ERROR: " + $_.Exception.Message)
  exit 1
}
