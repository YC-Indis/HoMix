param(
  [ValidateSet('all', 'arm64', 'x64')]
  [string]$Architecture = 'arm64'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$macosRoot = Join-Path $projectRoot 'macos'
$buildRoot = Join-Path $projectRoot 'build\macos'
$cacheRoot = Join-Path $projectRoot 'build\macos-packages'
$distRoot = Join-Path $projectRoot 'dist'
$version = '0.20.5'
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

$node = (Get-Command node.exe -ErrorAction Stop).Source
$zipScript = Join-Path $macosRoot 'create-macos-zip.js'
if (-not (Test-Path -LiteralPath (Join-Path $macosRoot 'node_modules\archiver'))) {
  throw 'macOS build dependencies are missing. Run pnpm install in the macos folder first.'
}

$runtimes = @{
  arm64 = @{
    Label = 'Apple-Silicon'
    ElectronUrl = 'https://npmmirror.com/mirrors/electron/43.2.0/electron-v43.2.0-darwin-arm64.zip'
    FfmpegUrl = 'https://registry.npmmirror.com/@ffmpeg-installer/darwin-arm64/-/darwin-arm64-4.1.5.tgz'
    FfprobeUrl = 'https://registry.npmmirror.com/@ffprobe-installer/darwin-arm64/-/darwin-arm64-5.0.1.tgz'
  }
  x64 = @{
    Label = 'Intel-x64'
    ElectronUrl = 'https://npmmirror.com/mirrors/electron/43.2.0/electron-v43.2.0-darwin-x64.zip'
    FfmpegUrl = 'https://registry.npmmirror.com/@ffmpeg-installer/darwin-x64/-/darwin-x64-4.1.0.tgz'
    FfprobeUrl = 'https://registry.npmmirror.com/@ffprobe-installer/darwin-x64/-/darwin-x64-5.1.0.tgz'
  }
}

function Get-ElectronZip([string]$arch, [string]$url) {
  $archive = Join-Path $cacheRoot "electron-v43.2.0-darwin-$arch.zip"
  if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $url -OutFile $archive
  }
  return $archive
}

function Get-RuntimeBinary([string]$arch, [string]$name, [string]$url) {
  $packageDir = Join-Path $cacheRoot "$name-$arch"
  $binary = Join-Path $packageDir "package\$name"
  if (Test-Path -LiteralPath $binary) { return $binary }
  New-Item -ItemType Directory -Force -Path $packageDir | Out-Null
  $archive = Join-Path $cacheRoot "$name-$arch.tgz"
  if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest -Uri $url -OutFile $archive
  }
  & tar -xzf $archive -C $packageDir
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $binary)) {
    throw "Unable to extract $name for $arch."
  }
  return $binary
}

function New-MacBuild([string]$arch) {
  $runtime = $runtimes[$arch]
  $stage = Join-Path $buildRoot "stage-$arch"
  foreach ($directory in @($stage)) {
    if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'tools') | Out-Null

  Copy-Item -LiteralPath (Join-Path $projectRoot 'server.js') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $projectRoot 'public') -Destination $stage -Recurse
  Copy-Item -LiteralPath (Join-Path $macosRoot 'electron-main.js') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $macosRoot 'preload.js') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $projectRoot 'MACOS_README.txt') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $macosRoot 'MACOS_FIRST_RUN.command') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.txt') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $projectRoot 'tools\LICENSE') -Destination (Join-Path $stage 'tools\FFMPEG_GPL-3.0.txt')
  Copy-Item -LiteralPath (Get-RuntimeBinary $arch 'ffmpeg' $runtime.FfmpegUrl) -Destination (Join-Path $stage 'tools\ffmpeg')
  Copy-Item -LiteralPath (Get-RuntimeBinary $arch 'ffprobe' $runtime.FfprobeUrl) -Destination (Join-Path $stage 'tools\ffprobe')

  $manifest = @{
    name = 'homix'
    productName = 'HoMix'
    version = $version
    description = '本地视频镜头分析与混剪工作台'
    main = 'electron-main.js'
    private = $true
  } | ConvertTo-Json
  Set-Content -LiteralPath (Join-Path $stage 'package.json') -Value $manifest -Encoding utf8

  $zip = Join-Path $distRoot "HoMix-$version-macOS-$($runtime.Label)-internal-unsigned.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  & $node $zipScript (Get-ElectronZip $arch $runtime.ElectronUrl) $stage $zip $version
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $zip)) { throw "ZIP creation failed for $arch." }
}

New-Item -ItemType Directory -Force -Path $buildRoot,$cacheRoot,$distRoot | Out-Null
$targets = if ($Architecture -eq 'all') { @('arm64', 'x64') } else { @($Architecture) }
foreach ($target in $targets) { New-MacBuild $target }
Get-ChildItem -LiteralPath $distRoot -Filter "HoMix-$version-macOS-*-internal-unsigned.zip" | Get-FileHash -Algorithm SHA256 | Select-Object Path,Hash
