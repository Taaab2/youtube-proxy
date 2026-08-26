# YouTube Proxy - one-time updater setup. Registers the native messaging host so the
# extension's "update now" button can run update.bat. Safe to run again any time (e.g.
# if you move the extension folder - just re-run it from the new location).
$ErrorActionPreference = "Stop"

# Must match the id Chrome derives from the "key" in manifest.json. If you regenerate
# that key, update this too, or the browser will refuse the native host.
$extId = "kmheagojoblajngklnaajhdfkglpbgmk"
$hostName = "com.rafi.ytproxy.updater"

$extDir = Split-Path -Parent $PSCommandPath
$batPath = Join-Path $extDir "nm-host.bat"
if (-not (Test-Path -LiteralPath $batPath)) {
  Write-Host "ERROR: nm-host.bat not found next to this script ($extDir)" -ForegroundColor Red
  exit 1
}

$manifest = [ordered]@{
  name            = $hostName
  description     = "YouTube Proxy self-updater"
  path            = $batPath
  type            = "stdio"
  allowed_origins = @("chrome-extension://$extId/")
}

# Store the host manifest outside the extension folder so an update can never clobber it.
$cfgDir = Join-Path $env:LOCALAPPDATA "ytproxy"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null
$manifestPath = Join-Path $cfgDir "$hostName.json"

# Chrome requires UTF-8 WITHOUT a BOM, and the path may contain non-ASCII (e.g. a
# Hebrew folder name), so write UTF-8 no-BOM explicitly rather than via Set-Content.
$json = $manifest | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($manifestPath, $json, (New-Object Text.UTF8Encoding($false)))

# Register the host for the Chromium browsers the user might run. Chrome is required;
# the others are best-effort so the same install works on Edge/Brave.
$roots = @(
  "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName",
  "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName",
  "HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\$hostName"
)
foreach ($key in $roots) {
  try {
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(default)" -Value $manifestPath
  }
  catch {
    # A browser that isn't installed just means its registry root is missing - ignore.
  }
}

Write-Host ""
Write-Host "YouTube Proxy updater is set up." -ForegroundColor Green
Write-Host "  extension folder : $extDir"
Write-Host "  host manifest    : $manifestPath"
Write-Host "  extension id     : $extId"
Write-Host ""
Write-Host "If you loaded the extension and its id is NOT the one above, the button"
Write-Host "won't work - tell the developer, the manifest key and this id must match."
