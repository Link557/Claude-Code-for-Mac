# Recycle only explicitly named old builds after the replacement passes smoke checks.
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][string]$KeepDirectory,
  [Parameter(Mandatory)][string[]]$ObsoleteDirectory
)
$ErrorActionPreference = 'Stop'
$keep = Get-Item -LiteralPath $KeepDirectory
$root = Get-Item -LiteralPath $keep.Parent.FullName
function Assert-BuildDirectory($item) {
  $target = [IO.Path]::GetFullPath($item.FullName)
  if (!$item.PSIsContainer -or $item.Name -notlike 'claude-desk-windows-*' -or
      (Split-Path $target -Parent) -ne $root.FullName -or
      !$target.StartsWith($root.FullName + '\', [StringComparison]::OrdinalIgnoreCase) -or
      ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
      !(Test-Path -LiteralPath (Join-Path $target 'win-unpacked\Claude Code.exe'))) {
    throw "Refusing an unrecognized build path: $target"
  }
}
Assert-BuildDirectory $keep
$shell = New-Object -ComObject WScript.Shell
$links = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Claude Code.lnk'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Claude Code.lnk')
)
foreach ($link in $links) {
  if (!(Test-Path -LiteralPath $link) -or
      !($shell.CreateShortcut($link).TargetPath.Equals((Join-Path $keep.FullName 'win-unpacked\Claude Code.exe'), [StringComparison]::OrdinalIgnoreCase))) {
    throw "Update the shortcut before cleanup: $link"
  }
}
$candidates = @($ObsoleteDirectory | ForEach-Object { Get-Item -LiteralPath $_ } | Sort-Object FullName -Unique)
$running = @(Get-Process -Name 'Claude Code' -ErrorAction SilentlyContinue)
foreach ($candidate in $candidates) {
  Assert-BuildDirectory $candidate
  if ($candidate.FullName.Equals($keep.FullName, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cannot recycle the current build.' }
  if ($running | Where-Object { $_.Path -and $_.Path.StartsWith($candidate.FullName + '\', [StringComparison]::OrdinalIgnoreCase) }) {
    throw "An old build is still running: $($candidate.FullName)"
  }
}
Add-Type -AssemblyName Microsoft.VisualBasic
foreach ($candidate in $candidates) {
  if ($PSCmdlet.ShouldProcess($candidate.FullName, 'Move obsolete Windows app build to Recycle Bin')) {
    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($candidate.FullName, 'OnlyErrorDialogs', 'SendToRecycleBin')
    if (Test-Path -LiteralPath $candidate.FullName) { throw "Build was not recycled: $($candidate.FullName)" }
  }
}
Write-Output "Kept: $($keep.FullName); explicitly selected obsolete builds: $($candidates.Count)"
