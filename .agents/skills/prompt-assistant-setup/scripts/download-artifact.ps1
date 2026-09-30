# download-artifact.ps1 — 下载两个产品的最新版安装包（GitHub API 实时查最新 release + sha256 校验 + 镜像回退）
# 用法: powershell -ExecutionPolicy Bypass -File download-artifact.ps1 [-Product assistant|clipper] [-OutDir <dir>]
# 逻辑: 先查 GitHub API 拿最新 release（直连→apiMirrors 镜像），按 assetPattern 匹配资产，
#       下载后用 API 返回的官方 digest 校验；API 全部不可达时回退 sources.json fallback 节的已验证版本。
#       下载源回退链: github 直连 → githubMirrors 各镜像。
# 退出码: 0=成功 1=参数/环境错误 2=校验失败 3=下载失败 4=找不到资产/未匹配到版本
param(
  [Parameter(Mandatory=$true)][ValidateSet('assistant','clipper')][string]$Product,
  [string]$OutDir = $env:TEMP
)

$ErrorActionPreference = 'Stop'
# sources.json 在 skill 根目录（scripts/ 的上一级）
$skillRoot = Split-Path $PSScriptRoot -Parent
$sourcesFile = Join-Path $skillRoot 'sources.json'
if (-not (Test-Path $sourcesFile)) { Write-Error "找不到 sources.json"; exit 1 }
$src = Get-Content $sourcesFile -Raw -Encoding UTF8 | ConvertFrom-Json

$key = if ($Product -eq 'assistant') { 'promptAssistant' } else { 'webClipper' }
$item = $src.$key
$fb = $src.fallback.$key

# ---------- 第 1 步：查最新 release ----------
$apiBase = "repos/$($item.repo)/releases/latest"
$apiUrls = @("https://api.github.com/$apiBase") +
           (@($src.apiMirrors) | ForEach-Object { "${_}https://api.github.com/$apiBase" })

$rel = $null
$apiOk = $false
foreach ($u in $apiUrls) {
  try {
    Write-Host "查询 $($item.name) 最新版本 ..."
    Write-Host "  API: $u"
    # GH API 必须带 UA；Accept 头让它返回明确 digest 字段
    $hdr = @{ 'User-Agent' = 'prompt-assistant-setup-skill'; 'Accept' = 'application/vnd.github+json' }
    $rel = Invoke-RestMethod -Uri $u -Headers $hdr -TimeoutSec 20
    if ($rel.tag_name) { $apiOk = $true; break }
  } catch {
    Write-Warning "该 API 源失败: $($_.Exception.Message)"
    $rel = $null
  }
}

# ---------- 第 2 步：确定下载目标（最新版 or 兜底版）----------
$usingFallback = -not $apiOk
if ($apiOk) {
  $tag = $rel.tag_name
  # 按 digest 优先匹配资产：GH API 对带 digest 的资产直接用；老 API 无 digest 时取 name
  $asset = $rel.assets | Where-Object { $_.name -match $item.assetPattern } | Select-Object -First 1
  if (-not $asset) { Write-Error "release $tag 里没匹配到资产 $($item.assetPattern)"; exit 4 }
  $assetName = $asset.name
  $digest = $asset.digest
  if ($digest) { $digest = ($digest -replace '^sha256:','').ToLower() }
  # 统一用浏览器直链下载（github.com/.../download/... 形态），api 资产 URL 需要
  # Accept: application/octet-stream 且不支持镜像前缀，只用来取版本号和 digest
  $dl = "https://github.com/$($item.repo)/releases/download/$tag/$assetName"
  Write-Host "最新版本: $tag（$assetName）"
} else {
  Write-Warning "GitHub API 全部不可达，回退兜底版本 $($fb.tag)（sources.json fallback）"
  $tag = $fb.tag; $assetName = $fb.asset; $digest = $fb.digest.ToLower()
  $dl = "https://github.com/$($item.repo)/releases/download/$tag/$assetName"
}

if (-not $digest) {
  # API 可达但资产无 digest 字段（极旧 API/企业代理改写）：退回 fallback 的 digest 校验值不可信，
  # 直接不校验并明确提示
  Write-Warning "API 未返回官方 sha256，本次下载将不做完整性校验"
}

# ---------- 第 3 步：下载（直连→镜像回退）----------
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$dest = Join-Path $OutDir $assetName
if (Test-Path $dest) { Remove-Item $dest -Force }

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# 下载源：github 浏览器直链（302 到 CDN）→ 各镜像前缀
$urls = @($dl) + (@($src.githubMirrors) | ForEach-Object { "${_}$dl" })

$ok = $false
foreach ($u in $urls) {
  try {
    Write-Host "下载 $($item.name) $tag ..."
    Write-Host "  源: $u"
    & curl.exe -sL --fail --retry 2 --connect-timeout 15 -o "$dest" $u
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $dest)) { throw "curl 退出码 $LASTEXITCODE" }
    # 下到 0 字节 / HTML 错误页都算失败，换下一个源
    if ((Get-Item $dest).Length -lt 1024) { throw "文件小于 1KB，疑为错误页" }
    $ok = $true; break
  } catch {
    Write-Warning "该源失败: $($_.Exception.Message)"
    if (Test-Path $dest) { Remove-Item $dest -Force }
    $ok = $false
  }
}
if (-not $ok) { Write-Error "所有下载源均失败"; exit 3 }

# ---------- 第 4 步：sha256 校验 ----------
if ($digest) {
  $hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
  Write-Host "sha256: $hash"
  if ($hash -ne $digest) {
    Write-Error "校验失败！期望 $digest，实际 $hash。文件已删除；请重试或换网络。"
    Remove-Item $dest -Force
    exit 2
  }
  Write-Host "校验通过 OK  文件: $dest（$([math]::Round((Get-Item $dest).Length/1MB,1)) MB）"
} else {
  Write-Host "已下载（未校验）: $dest（$([math]::Round((Get-Item $dest).Length/1MB,1)) MB）"
}
if ($usingFallback) { Write-Warning "注意: 本次装的是兜底旧版 $tag；GitHub API 恢复后重跑可升到最新" }
exit 0
