# check-env.ps1 — 安装前环境预检（只读，不改任何东西）
# 用法: powershell -ExecutionPolicy Bypass -File check-env.ps1
# 输出: 各项检测结果 + 一行 JSON 汇总（agent 便于解析），退出码 0
$ErrorActionPreference = 'SilentlyContinue'
$result = [ordered]@{}

# 1. OS（仅支持 Windows 10+）
$os = Get-CimInstance Win32_OperatingSystem
$result.os = "$($os.Caption) $($os.Version) $($os.OSArchitecture)"
$osOk = ($os.Version -match '^10\.|^11\.') -or ($os.BuildNumber -ge 19045)
Write-Host ("OS          : {0}  {1}" -f $result.os, $(if ($osOk) {'OK'} else {'太旧，建议 Win10 19045+'}))

# 2. 浏览器（Edge 是 Chromium 内核，装不上独立 Chrome 时可作兜底）
$edge = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe' -ErrorAction SilentlyContinue
$chrome = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe' -ErrorAction SilentlyContinue
$browser = if ($chrome) { 'Chrome' } elseif ($edge) { 'Edge (Chromium)' } else { $null }
Write-Host ("浏览器      : {0}" -f $(if ($browser) { "$browser OK" } else { '未发现 Chrome/Edge，插件无法安装' }))
$result.browser = $browser

# 3. 磁盘（安装包+应用+媒体缓存建议预留 2GB）
$drive = Get-PSDrive C
$freeGB = [math]::Round($drive.Free / 1GB, 1)
Write-Host ("C 盘剩余    : {0} GB  {1}" -f $freeGB, $(if ($freeGB -ge 2) {'OK'} else {'不足 2GB，注意媒体缓存空间'}))
$result.freeGB = $freeGB

# 4. 网络：npmmirror（lark-cli）、GitHub 直连/镜像（安装包下载）、GitHub API（动态查最新版）
$net = @{}
foreach ($u in @('https://registry.npmmirror.com', 'https://github.com', 'https://ghproxy.net', 'https://api.github.com')) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $code = (& curl.exe -s -o NUL --connect-timeout 8 -w "%{http_code}" $u) 2>$null
  $net[$u] = "$code ($($sw.ElapsedMilliseconds)ms)"
}
Write-Host ("网络        : npmmirror={0}  github直连={1}  镜像={2}  github-api={3}" -f $net['https://registry.npmmirror.com'], $net['https://github.com'], $net['https://ghproxy.net'], $net['https://api.github.com'])
$result.net = $net
# api.github.com 与镜像 gh-proxy.com 都挂时，下载脚本会回退 sources.json 兜底旧版——预检就提示出来
$apiOk = ($net['https://api.github.com'] -match '^200') -or ($net['https://ghproxy.net'] -match '^200')
if (-not $apiOk) { Write-Host "             注意: GitHub API 探测异常，安装时可能装到兜底旧版（见 sources.json）" }

# 5. 已装旧版？（覆盖升级 or 跳过下载）
$installed = @()
foreach ($p in @("$env:LOCALAPPDATA\Programs\提示词助手\提示词助手.exe")) {
  if (Test-Path $p) { $installed += $p }
}
$uninstall = Get-ItemProperty 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like '*提示词助手*' }
if ($uninstall) { $installed += "注册表: $($uninstall.DisplayName) $($uninstall.DisplayVersion)" }
Write-Host ("已装旧版    : {0}" -f $(if ($installed) { $installed -join ' | ' } else { '无' }))
$result.installed = $installed

# 6. lark-cli 现状（PATH 里的 npm 版 / 应用 runtime 里的便携版 / 都没有）
$cliPath = (Get-Command lark-cli.cmd -ErrorAction SilentlyContinue).Source
$portable = Join-Path $env:APPDATA '提示词助手\runtime\lark-cli\lark-cli.exe'
$cli = if ($cliPath) { "PATH: $cliPath" } elseif (Test-Path $portable) { "便携: $portable" } else { $null }
if ($cli) {
  $raw = & $cliPath --version 2>$null; if (-not $raw) { $raw = & $portable --version 2>$null }
  if ($raw -match '(\d+\.\d+\.\d+)') { $cli = "$cli (v$($Matches[1]))" }
}
Write-Host ("lark-cli    : {0}" -f $(if ($cli) { $cli } else { '未安装（本 skill 会装便携版）' }))
$result.larkCli = $cli

# 7. 应用配置（装过但没配数据源/登录态的情况）
$cfgFile = Join-Path $env:APPDATA '提示词助手\config.json'
if (Test-Path $cfgFile) {
  $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $result.configured = [bool]$cfg.baseToken
  Write-Host ("应用配置    : {0}" -f $(if ($cfg.baseToken) { '已配置多维表数据源' } else { '装过但未配置数据源' }))
} else {
  $result.configured = $false
  Write-Host "应用配置    : 未装过（全新安装）"
}

Write-Host "---JSON---"
$result | ConvertTo-Json -Compress
exit 0
