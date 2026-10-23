$ErrorActionPreference = 'Stop'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = (Resolve-Path "release/CopyCopy-Setup-$version.exe").Path
$target = Join-Path $env:RUNNER_TEMP 'CopyCopy-update-test'
$dataRoot = Join-Path $env:APPDATA 'CopyCopy/data'
if (Test-Path $dataRoot) { throw 'Installer test requires an isolated runner profile' }

function Install-CopyCopy {
  $process = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$target") -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "Installer exited with $($process.ExitCode)" }
  if (!(Test-Path "$target/CopyCopy.exe")) { throw 'Installed executable missing' }
}

Install-CopyCopy
# Simulate the data layout of 1.2 before a destructive NSIS replacement.
New-Item -ItemType Directory -Force "$target/config", "$target/out/迁移漫画/第1话", "$target/logs", "$target/cache" | Out-Null
Set-Content -Encoding utf8 "$target/config/comic.yaml" '{"global":{"concurrency":7},"comics":[]}'
Set-Content -Encoding utf8 "$target/out/迁移漫画/第1话/001.jpg" 'manga-page-fixture'
Set-Content -Encoding utf8 "$target/logs/test.log" 'log-fixture'
Set-Content -Encoding utf8 "$target/cache/cover.jpg" 'cover-fixture'
$files = @('config/comic.yaml', 'out/迁移漫画/第1话/001.jpg', 'logs/test.log', 'cache/cover.jpg')
$hashes = @{}
foreach ($file in $files) { $hashes[$file] = (Get-FileHash "$target/$file" -Algorithm SHA256).Hash }
# A conflict must stop before any directory has been copied or uninstalled.
New-Item -ItemType Directory -Force "$dataRoot/out" | Out-Null
Set-Content -Encoding utf8 "$dataRoot/out/existing.txt" 'existing-library'
$conflict = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$target") -Wait -PassThru
if ($conflict.ExitCode -eq 0) { throw 'Installer accepted conflicting data directories' }
if (Test-Path "$dataRoot/config") { throw 'Conflict detection copied partial data' }
foreach ($file in $files) {
  if ((Get-FileHash "$target/$file" -Algorithm SHA256).Hash -ne $hashes[$file]) { throw "Conflict handling modified old data $file" }
}
if ((Get-Content "$dataRoot/out/existing.txt" -Raw).Trim() -ne 'existing-library') { throw 'Existing library was modified' }
Remove-Item "$dataRoot/out" -Recurse -Force
Install-CopyCopy
foreach ($file in $files) {
  if ((Get-FileHash "$dataRoot/$file" -Algorithm SHA256).Hash -ne $hashes[$file]) { throw "Migration corrupted $file" }
}
Install-CopyCopy
foreach ($file in $files) {
  if ((Get-FileHash "$dataRoot/$file" -Algorithm SHA256).Hash -ne $hashes[$file]) { throw "Reinstall modified user data $file" }
}
Write-Output 'PASS  Windows 安装、冲突中止、旧目录数据迁移、重复升级保留数据（逐文件 SHA256 校验）'
