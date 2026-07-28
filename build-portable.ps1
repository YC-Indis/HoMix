param(
  [string]$OutputDirectory = ''
)

$ErrorActionPreference = 'Stop'

$projectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$distRoot = if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  [IO.Path]::GetFullPath((Join-Path $projectRoot 'dist\HoMix'))
} elseif ([IO.Path]::IsPathRooted($OutputDirectory)) {
  [IO.Path]::GetFullPath($OutputDirectory)
} else {
  [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
}
if (-not $distRoot.StartsWith($projectRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Output directory is outside the HoMix project.'
}

if (Test-Path -LiteralPath $distRoot) {
  # Keep the root folder itself: Windows can hold a harmless current-directory
  # handle after the desktop app exits, which prevents deleting the directory
  # even though all files inside it are replaceable.
  Get-ChildItem -LiteralPath $distRoot -Force | Remove-Item -Recurse -Force
} else {
  New-Item -ItemType Directory -Path $distRoot | Out-Null
}
New-Item -ItemType Directory -Force -Path $distRoot,(Join-Path $distRoot 'runtime'),(Join-Path $distRoot 'data\projects') | Out-Null

$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$webViewLib = Join-Path $projectRoot 'vendor\WebView2\lib\net462'
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /win32manifest:"$projectRoot\HoMix.exe.manifest" /out:"$distRoot\HoMix.exe" /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Core.dll /reference:"$webViewLib\Microsoft.Web.WebView2.Core.dll" /reference:"$webViewLib\Microsoft.Web.WebView2.WinForms.dll" "$projectRoot\HoMixLauncher.cs"
if ($LASTEXITCODE -ne 0) { throw "HoMix.exe compile failed: $LASTEXITCODE" }

Copy-Item -LiteralPath (Join-Path $projectRoot 'server.js') -Destination $distRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'public') -Destination $distRoot -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'tools') -Destination $distRoot -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot 'PORTABLE_README.txt') -Destination $distRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'THIRD_PARTY_NOTICES.txt') -Destination $distRoot
Copy-Item -LiteralPath $node -Destination (Join-Path $distRoot 'runtime\node.exe')
Copy-Item -LiteralPath (Join-Path $webViewLib 'Microsoft.Web.WebView2.Core.dll') -Destination $distRoot
Copy-Item -LiteralPath (Join-Path $webViewLib 'Microsoft.Web.WebView2.WinForms.dll') -Destination $distRoot
Copy-Item -LiteralPath (Join-Path $projectRoot 'vendor\WebView2\runtimes\win-x64\native\WebView2Loader.dll') -Destination $distRoot

Write-Host "HoMix portable build created: $distRoot"
