$ErrorActionPreference = 'Stop'
$root = Join-Path $env:RUNNER_TEMP 'copycopy-native-smoke'
New-Item -ItemType Directory -Force $root | Out-Null
$env:COPYCOPY_DATA_DIR = $root
$env:COPYCOPY_SMOKE_REPORT = Join-Path $root 'report.json'
$process = Start-Process -FilePath 'src-tauri/target/release/copycopy.exe' -PassThru -RedirectStandardError (Join-Path $root 'stderr.txt')
try {
  $deadline = (Get-Date).AddSeconds(40)
  while (!(Test-Path $env:COPYCOPY_SMOKE_REPORT) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
  if (!(Test-Path $env:COPYCOPY_SMOKE_REPORT)) {
    Get-Content (Join-Path $root 'stderr.txt') -ErrorAction SilentlyContinue | Write-Output
    Write-Output ('Native process exited: ' + $process.HasExited)
    throw 'Native WebView did not complete the smoke check'
  }
  $report = Get-Content $env:COPYCOPY_SMOKE_REPORT -Raw | ConvertFrom-Json
  if (!$report.ok -or !$report.bridge) { throw ($report | ConvertTo-Json) }
  Write-Output ('PASS actual Tauri WebView2 window, frontend mount, Rust IPC, settings write and library/queue reads: ' + $report.version)
} finally {
  if (!$process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
}
