# YouTube Proxy - native messaging host. Chrome launches this (via nm-host.bat) when
# the extension's "update now" button fires chrome.runtime.sendNativeMessage. It speaks
# the native messaging wire protocol (4-byte little-endian length prefix + JSON), runs
# update.bat to completion, and reports the result back so the extension can reload only
# after the new files are on disk.
$ErrorActionPreference = "Stop"

try {
  $stdin  = [Console]::OpenStandardInput()
  $stdout = [Console]::OpenStandardOutput()

  # Read the 4-byte length prefix, then the JSON message. We don't need the message
  # contents - any message means "update" - but we must drain it per the protocol.
  $lenBuf = New-Object byte[] 4
  $got = $stdin.Read($lenBuf, 0, 4)
  if ($got -ge 4) {
    $len = [BitConverter]::ToInt32($lenBuf, 0)
    if ($len -gt 0 -and $len -lt 1048576) {
      $msg = New-Object byte[] $len
      $off = 0
      while ($off -lt $len) {
        $n = $stdin.Read($msg, $off, $len - $off)
        if ($n -le 0) { break }
        $off += $n
      }
    }
  }

  $extDir = Split-Path -Parent $PSCommandPath
  $ok = $true
  $err = ""
  try {
    $p = Start-Process -FilePath (Join-Path $extDir "update.bat") -WorkingDirectory $extDir -WindowStyle Hidden -Wait -PassThru
    if ($p.ExitCode -ne 0) { $ok = $false; $err = "update.bat exited with code $($p.ExitCode)" }
  }
  catch {
    $ok = $false
    $err = $_.Exception.Message
  }

  $obj = @{ ok = $ok }
  if (-not $ok) { $obj.error = $err }
  $json = $obj | ConvertTo-Json -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $stdout.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}
catch {
  # Best effort - if we can't even respond, Chrome surfaces a disconnect to the caller.
}
