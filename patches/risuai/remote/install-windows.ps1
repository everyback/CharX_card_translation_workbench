param(
  [string]$Root = '',
  [ValidateSet('', 'bridge', 'patch', 'both')]
  [string]$Mode = '',
  [string]$Patch = '',
  [switch]$Apply,
  [switch]$NoPause
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$installer = Join-Path $scriptDir 'install-remote.mjs'

function Stop-WithMessage([string]$Message) {
  Write-Host ''
  Write-Host $Message -ForegroundColor Red
  if (-not $NoPause) { Read-Host '按 Enter 退出' | Out-Null }
  exit 1
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Stop-WithMessage '没有找到 Node.js。请先安装 Node.js 18 或更高版本，再双击 install-windows.cmd。'
}
if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) {
  Stop-WithMessage "安装包不完整：找不到 $installer"
}

function Invoke-RisuInstaller([string[]]$Arguments) {
  & node $installer @Arguments
  if ($LASTEXITCODE -ne 0) { throw "安装器退出码：$LASTEXITCODE" }
}

function Select-RisuRoot {
  param([string]$ExplicitRoot)
  if ($ExplicitRoot) {
    if (-not (Test-Path -LiteralPath $ExplicitRoot -PathType Container)) {
      throw "指定的 RisuAI 目录不存在：$ExplicitRoot"
    }
    return (Resolve-Path -LiteralPath $ExplicitRoot).Path
  }

  $json = (& node $installer --discover | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw '自动搜索 RisuAI 目录失败。' }
  $roots = @($json | ConvertFrom-Json)
  if ($roots.Count -eq 0) {
    throw '没有自动找到 RisuAI 目录。请使用 -Root 指定目录，或把安装包放到 RisuAI 目录中再运行。'
  }
  if ($roots.Count -eq 1) {
    Write-Host "已找到 RisuAI：$($roots[0])" -ForegroundColor Green
    return [string]$roots[0]
  }

  Write-Host '找到多个可能的 RisuAI 目录，请选择：' -ForegroundColor Yellow
  for ($index = 0; $index -lt $roots.Count; $index += 1) {
    Write-Host ("[{0}] {1}" -f ($index + 1), $roots[$index])
  }
  $selection = Read-Host "输入编号（1-$($roots.Count)）"
  $number = 0
  if (-not [int]::TryParse($selection, [ref]$number) -or $number -lt 1 -or $number -gt $roots.Count) {
    throw '目录编号无效。'
  }
  return [string]$roots[$number - 1]
}

function Select-Mode {
  Write-Host ''
  Write-Host 'CardLoom Translate - RisuAI 安装器' -ForegroundColor Cyan
  Write-Host '1. 安装桥接插件（RISUSAVE）'
  Write-Host '2. 安装源码补丁'
  Write-Host '3. 两者都安装'
  $selection = Read-Host '请选择 [1/2/3]'
  switch ($selection) {
    '1' { return 'bridge' }
    '2' { return 'patch' }
    '3' { return 'both' }
    default { throw '安装类型无效。' }
  }
}

function Select-Patch {
  if ($Patch) { return $Patch }
  $patches = @(
    'plugin-v21-import',
    'preset-switch',
    'api-profiles',
    'image-router',
    'read-performance',
    'read-cache',
    'list-cache'
  )
  Write-Host ''
  Write-Host '请选择源码补丁：' -ForegroundColor Cyan
  for ($index = 0; $index -lt $patches.Count; $index += 1) {
    Write-Host ("[{0}] {1}" -f ($index + 1), $patches[$index])
  }
  $selection = Read-Host "输入编号（1-$($patches.Count)）"
  $number = 0
  if (-not [int]::TryParse($selection, [ref]$number) -or $number -lt 1 -or $number -gt $patches.Count) {
    throw '补丁编号无效。'
  }
  return $patches[$number - 1]
}

function Confirm-And-Apply([string[]]$Arguments) {
  Write-Host ''
  Write-Host '预检完成。上面的输出确认目标文件和 RISUSAVE 正确后，才会写入。' -ForegroundColor Yellow
  if (-not $Apply) {
    $answer = Read-Host '输入 INSTALL 继续安装，其他内容退出'
    if ($answer -cne 'INSTALL') {
      Write-Host '已取消，未修改 RisuAI。' -ForegroundColor DarkYellow
      if (-not $NoPause) { Read-Host '按 Enter 退出' | Out-Null }
      exit 0
    }
  }
  Invoke-RisuInstaller ($Arguments + @('--apply'))
  Write-Host '安装完成。请重启 RisuAI 或重新构建受影响的源码。' -ForegroundColor Green
}

try {
  $selectedRoot = Select-RisuRoot $Root
  $selectedMode = if ($Mode) { $Mode } else { Select-Mode }
  if ($selectedMode -in @('bridge', 'both')) {
    Write-Host ''
    Write-Host '第一步：检查桥接插件和 RISUSAVE' -ForegroundColor Cyan
    $bridgeArgs = @('--root', $selectedRoot, '--mode', 'bridge')
    Invoke-RisuInstaller $bridgeArgs
    Confirm-And-Apply $bridgeArgs
  }
  if ($selectedMode -in @('patch', 'both')) {
    $selectedPatch = Select-Patch
    Write-Host ''
    Write-Host "检查源码补丁：$selectedPatch" -ForegroundColor Cyan
    $patchArgs = @('--root', $selectedRoot, '--mode', 'patch', '--patch', $selectedPatch)
    Invoke-RisuInstaller $patchArgs
    Confirm-And-Apply $patchArgs
  }
} catch {
  Stop-WithMessage $_.Exception.Message
}

if (-not $NoPause) { Read-Host '按 Enter 退出' | Out-Null }
