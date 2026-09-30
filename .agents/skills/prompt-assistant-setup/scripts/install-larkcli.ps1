# install-larkcli.ps1 — 便携安装 lark-cli（飞书官方单文件版，npmmirror 镜像，免 Node/npm）
# 用法: powershell -ExecutionPolicy Bypass -File install-larkcli.ps1 [-OutDir <dir>]
#   OutDir 默认 = 提示词助手的 userData\runtime\lark-cli（应用自己的「一键自动配置」也装在这里，二者互相识别）
# 行为: 查最新版 -> 下载 windows-amd64 zip -> sha256 对官方 checksums.txt 校验 -> 解压 -> --version 验证
# 退出码: 0=成功(或已安装且可用) 2=校验失败 3=下载失败 5=解压/验证失败
param(
  [string]$OutDir = (Join-Path $env:APPDATA '提示词助手\runtime\lark-cli')
)

$ErrorActionPreference = 'Stop'
$mirror = 'https://registry.npmmirror.com'
$fallbackVer = '1.0.96'

# 已装好且能跑就直接退出，不重复下载
$exe = Join-Path $OutDir 'lark-cli.exe'
if (Test-Path $exe) {
  try {
    $v = & $exe --version 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) { Write-Host "lark-cli 已可用: $exe ($v)"; exit 0 }
  } catch {}
}

Write-Host "查询 lark-cli 最新版本 ..."
$ver = $fallbackVer
try {
  $meta = Invoke-RestMethod -Uri "$mirror/@larksuite/cli/latest" -TimeoutSec 15
  if ($meta.version -match '^\d+\.\d+\.\d+$') { $ver = $meta.version }
} catch { Write-Warning "版本查询失败，使用回退版本 $fallbackVer" }
Write-Host "目标版本: v$ver"

$archive = "lark-cli-$ver-windows-amd64.zip"
$binBase = "$mirror/-/binary/lark-cli/v$ver"

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$tmp = Join-Path $OutDir $archive
if (Test-Path $tmp) { Remove-Item $tmp -Force }

Write-Host "下载 $archive（约 15MB）..."
& curl.exe -sL --fail --retry 2 --connect-timeout 15 -o "$tmp" "$binBase/$archive"
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmp)) { Write-Error "下载失败: $binBase/$archive"; exit 3 }

# sha256 对官方 checksums.txt（校验失败宁可中止，不装可疑文件）
$want = $null
try {
  $lines = (Invoke-RestMethod -Uri "$binBase/checksums.txt" -TimeoutSec 15) -split "`n"
  $line = $lines | Where-Object { $_ -match [regex]::Escape($archive) } | Select-Object -First 1
  if ($line) { $want = ($line.Trim() -split '\s+')[0] -replace '[^a-f0-9]','' }
} catch { Write-Warning "checksums.txt 拉取失败，跳过校验" }
if ($want) {
  $got = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
  if ($got -ne $want.ToLower()) {
    Write-Error "sha256 校验失败: 期望 $want 实际 $got"
    Remove-Item $tmp -Force
    exit 2
  }
  Write-Host "sha256 校验通过 ✓"
} else {
  Write-Warning "未取得官方校验值，本次安装未做完整性校验"
}

Write-Host "解压到 $OutDir ..."
$tarExe = Join-Path $env:SystemRoot 'System32\tar.exe'
if (Test-Path $tarExe) {
  & $tarExe -xf $tmp -C $OutDir
} else {
  Expand-Archive -LiteralPath $tmp -DestinationPath $OutDir -Force
}
Remove-Item $tmp -Force

if (-not (Test-Path $exe)) { Write-Error "解压后未找到 $exe"; exit 5 }
$v = & $exe --version 2>$null
if ($LASTEXITCODE -ne 0) { Write-Error "lark-cli.exe 运行验证失败"; exit 5 }
Write-Host "安装成功 ✓  $exe ($v)"
Write-Host "下一步: 用它执行 device-flow 登录（见 SKILL.md 阶段 4）"
exit 0
