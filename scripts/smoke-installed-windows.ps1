$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseDir = Join-Path $repoRoot 'release'
$installer = Get-ChildItem -Path $releaseDir -Filter '*Setup.exe' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $installer) { throw "No NSIS setup executable found in $releaseDir" }

$tempBase = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$tempRoot = Join-Path $tempBase 'aivideo-windows-smoke'
$installDir = Join-Path $tempRoot 'installed'
$healthPath = Join-Path $tempRoot 'media-runtime-health.json'
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
if (Test-Path $installDir) { Remove-Item -Path $installDir -Recurse -Force }
if (Test-Path $healthPath) { Remove-Item -Path $healthPath -Force }

# NSIS requires /D= to be the final argument; this path intentionally has no spaces.
$install = Start-Process -FilePath $installer.FullName -ArgumentList @('/S', "/D=$installDir") -Wait -PassThru
if ($install.ExitCode -ne 0) { throw "NSIS installer exited with code $($install.ExitCode)" }

$appExe = Join-Path $installDir 'AI Video Editor.exe'
if (-not (Test-Path $appExe)) { throw "Installed application was not found at $appExe" }

$health = Start-Process -FilePath $appExe -ArgumentList @('--media-health-check', "--media-health-check-output=$healthPath") -Wait -PassThru -WindowStyle Hidden
if (-not (Test-Path $healthPath)) { throw "Installed app did not write its media health report (exit $($health.ExitCode))." }
$report = Get-Content -Path $healthPath -Raw | ConvertFrom-Json
if ($health.ExitCode -ne 0 -or -not $report.ready -or -not $report.packaged) {
  throw "Installed runtime check failed: $($report | ConvertTo-Json -Depth 8)"
}
foreach ($tool in @('ffmpeg', 'ffprobe')) {
  $binary = $report.$tool
  if (-not $binary.available -or $binary.source -ne 'bundled' -or $binary.path -notmatch 'app\.asar\.unpacked') {
    throw "$tool was not resolved from the installed app's unpacked bundle: $($binary | ConvertTo-Json -Depth 5)"
  }
  if (-not (Test-Path $binary.path)) { throw "Packaged $tool path does not exist: $($binary.path)" }
  Write-Host "$tool installed and runnable: $($binary.version)"
}

# Keep the NSIS /D= installation path simple, but exercise the packaged binaries against Unicode media paths with spaces.
$unicodeMarker = ([char]0x0645).ToString() + ([char]0x4E2D).ToString()
$mediaRoot = Join-Path $tempRoot "Media $unicodeMarker with spaces"
$sourcePath = Join-Path $mediaRoot "source $unicodeMarker with spaces.mp4"
$outputPath = Join-Path $mediaRoot "vertical export $unicodeMarker final.mp4"
New-Item -ItemType Directory -Path $mediaRoot -Force | Out-Null

$ffmpegPath = [string]$report.ffmpeg.path
$ffprobePath = [string]$report.ffprobe.path
$generateArguments = @(
  '-hide_banner', '-y', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:r=25:d=2',
  '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', $sourcePath
)
& $ffmpegPath @generateArguments *> $null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $sourcePath)) { throw "Bundled FFmpeg could not write a Unicode-path fixture (exit $LASTEXITCODE)." }

$sourceProbeArguments = @('-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', $sourcePath)
$sourceProbeText = (& $ffprobePath @sourceProbeArguments 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "Bundled FFprobe could not read the Unicode-path fixture (exit $LASTEXITCODE)." }
$sourceProbe = $sourceProbeText | ConvertFrom-Json
$sourceVideo = @($sourceProbe.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1)
if ($sourceVideo.Count -ne 1 -or [double]$sourceProbe.format.duration -lt 1.8) {
  throw "Bundled FFprobe returned invalid fixture metadata: $sourceProbeText"
}

$exportArguments = @(
  '-hide_banner', '-y', '-loglevel', 'error', '-i', $sourcePath,
  '-vf', 'scale=360:640:force_original_aspect_ratio=increase,crop=360:640,setsar=1',
  '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', $outputPath
)
& $ffmpegPath @exportArguments *> $null
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outputPath)) { throw "Bundled FFmpeg could not export to a Unicode path (exit $LASTEXITCODE)." }

$outputProbeArguments = @('-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', $outputPath)
$outputProbeText = (& $ffprobePath @outputProbeArguments 2>&1 | Out-String)
if ($LASTEXITCODE -ne 0) { throw "Bundled FFprobe could not verify the Unicode-path export (exit $LASTEXITCODE)." }
$outputProbe = $outputProbeText | ConvertFrom-Json
$outputVideo = @($outputProbe.streams | Where-Object { $_.codec_type -eq 'video' } | Select-Object -First 1)
if ($outputVideo.Count -ne 1 -or [int]$outputVideo[0].width -ne 360 -or [int]$outputVideo[0].height -ne 640 -or [double]$outputProbe.format.duration -lt 1.8) {
  throw "Packaged-binary export verification failed: $outputProbeText"
}
Write-Host "Bundled FFmpeg/FFprobe created, probed, and exported media under: $mediaRoot"
Write-Host "NSIS install and packaged-media smoke test passed: $appExe"
