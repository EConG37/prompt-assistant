---
name: prompt-assistant-setup
description: 引导安装「提示词助手」Windows 托盘应用 + 配套「网页剪藏插件」浏览器扩展，并把两个产品的环境一次配好（下载安装包、lark-cli 便携安装、飞书登录授权、多维表数据源、剪藏插件飞书侧应用与凭据，逐项检查直到端到端可用）。当用户想安装/配置/重装提示词助手或剪藏插件、设置飞书多维表数据源、修复 lark-cli 环境，或提到「装一下提示词助手」「剪藏插件怎么配」「换电脑怎么迁移」时使用本 skill。
---

# 提示词助手 × 网页剪藏插件 — 一站式引导安装

你要把使用者的电脑从零配置成一套完整的「剪藏 → 飞书多维表 → 速查复制」工作流：

```
浏览器剪藏插件 ──写入──▶ 飞书多维表（数据中台） ──lark-cli 同步──▶ 提示词助手（托盘速查/复制）
```

两个产品都读/写**使用者自己的**飞书多维表，全程不需要你的任何密钥。你的角色是**引导者**：
能自动化的（下载、校验、安装、写配置、跑登录命令）直接做；必须本人操作的（浏览器授权登录、
飞书网页上建应用/建副本、浏览器扩展页加载）给出精确到点击位置的指引，等用户完成后继续。

**总原则：一步一步走，每步做完先检查、报告结果，再进下一步。** 不允许把所有命令一口气跑完。
每个阶段的末尾都有「✓ 检查」小节——检查不过就停下排查（查 `references/troubleshooting.md`），
过了才继续。全部 6 个阶段走完、端到端验收通过，才算完成。

**开工前先读这些**（按需渐进加载，不要一次全读）：

| 想了解什么 | 读哪个文件 |
| --- | --- |
| 两个产品各是什么、装完长什么样 | `references/products.md` |
| 飞书侧要配什么（多维表副本、企业自建应用、3 个权限、device-flow 登录原理） | `references/feishu-config.md` |
| 某步失败了的排查手段（下载不动、登录超时、91403/1254030、环境自检不过） | `references/troubleshooting.md` |

`sources.json`（skill 根目录）定义各产品的仓库与资产匹配规则，并保存一个**兜底版本**。
日常安装**始终动态拉最新版**：脚本实时查 GitHub API 取最新 release（带镜像回退）并按官方
digest 校验；只有 GitHub API 完全不可达时才装 sources.json fallback 节的已验证旧版。
产品发新版后 skill **无需任何维护**（可选：隔段时间把 fallback 更新为最新已验证版本）。

## 核心原则

1. **每完成一步，先检查再报告，然后才继续**。整个流程 6 个阶段（见下），阶段 4–5 需要用户
   本人配合（授权、贴链接、浏览器点击），你是在**协作**，不是在后台批处理。
2. **下载必须带 sha256 校验**（脚本已内置）。校验失败宁可停下，不要装来路不明的文件。
3. **不碰用户数据**：`%APPDATA%\提示词助手\` 下的 `cache.json` 是已同步的提示词数据，任何操作不得删除；
   修改 `config.json` 前先备份。不要动应用安装目录里的程序文件。
4. **国内网络现实**：GitHub 直连经常不通（时通时断），脚本已内置 3 个镜像回退 + npmmirror。
   下载失败时先怀疑网络，按 `references/troubleshooting.md` 处理，不要盲目重试。
5. 优先用 skill 自带脚本（下述），不要现场重新发明等价物。

## 流程总览（6 阶段，先下载后安装再配置，逐项检查）

```
1 预检 ─▶ 2 下载全部安装包 ─▶ 3 安装两个产品 ─▶ 4 配置助手侧+检查 ─▶ 5 配置插件侧+检查 ─▶ 6 端到端验收
```

以下 `$SKILL` 指 skill 根目录（含本文件的目录）。

### 阶段 1 · 环境预检（先跑，决定后面跳过哪些）

```powershell
powershell -ExecutionPolicy Bypass -File "$SKILL\scripts\check-env.ps1"
```

只读不改，输出 JSON。据此决策：

- OS 非 Win10/11 或非 x64 → 停下说明（本套产品仅支持 Windows；浏览器插件部分可装但助手不可用）。
- 无 Chrome/Edge → 阶段 3 前提醒装浏览器；Edge 可用但指引里菜单叫法不同（见 products.md）。
- `installed` 已有旧版 → 询问：直接覆盖升级（运行新安装包，NSIS 会保留 `%APPDATA%` 配置和数据）还是卸载重装。
- `larkCli` 已存在 → 阶段 4 只需确认登录态（跑 `auth status`），便携安装脚本会自动跳过。
- `configured = true` → 说明这台机器装过且配过数据源，先问用户是「换数据源」还是「修复问题」，别盲目重配。
- github 直连 000 → 正常现象，脚本自动走镜像；npmmirror 也不通才是问题（换网络/热点）。

**✓ 检查**：把预检结论用一两句话告诉用户，确认后进阶段 2。

### 阶段 2 · 把两个产品的安装包全部下载到用户电脑

先统一下载，全部落地且校验通过后才进安装阶段——网络问题在这一步暴露，不浪费安装时间。
（以下命令可并行跑两个进程；脚本自动 直连→镜像 回退。）

```powershell
# 助手安装包（约 80MB，下载到 %TEMP%）
powershell -ExecutionPolicy Bypass -File "$SKILL\scripts\download-artifact.ps1" -Product assistant -OutDir "$env:TEMP"
# 剪藏插件 zip（约 0.4MB）
powershell -ExecutionPolicy Bypass -File "$SKILL\scripts\download-artifact.ps1" -Product clipper -OutDir "$env:TEMP"
```

**✓ 检查**：两个脚本都必须输出「校验通过」并打印文件完整路径。报告给用户：
「两个安装包已下载并校验完毕：<助手 Setup x.x.x.exe 路径> + <插件 zip 路径>」。
任一下载失败 → 按 troubleshooting.md 处理，**不要**带着失败的下载进下一阶段。

### 阶段 3 · 引导安装两个产品

#### 3a. 安装提示词助手

- **运行安装包需要用户配合**：NSIS 是非一键式安装（可自选目录）。告诉用户你要启动安装向导了，
  用 `Start-Process "<下载的Setup路径>"` 启动，让用户在向导里点完「安装」。默认装到
  `%LOCALAPPDATA%\Programs\提示词助手`，无需管理员权限。
- 杀软/SmartScreen 拦截是常见现象，引导用户「更多信息 → 仍要运行」（见 troubleshooting.md）。

#### 3b. 安装剪藏插件（浏览器扩展）

先解压到**固定位置**（扩展长期引用该目录，放 %TEMP% 有被清理的风险）：

```powershell
$dest = "$env:USERPROFILE\Documents\feishu-web-clipper"
Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath "<下载的插件zip路径>" -DestinationPath $dest -Force
```

然后加载扩展**必须用户手工操作**（浏览器安全策略，任何脚本都替代不了），给出指引：

1. 打开新标签页访问 `chrome://extensions/`（Edge 为 `edge://extensions/`）
2. 右上角打开「开发者模式」（Edge 在左侧栏「开发人员模式」）
3. 点「加载已解压的扩展程序」，选择上面的解压目录（**含 manifest.json 的文件夹**）
4. 看到扩展卡片「网页剪藏到飞书多维表格」出现即成功

**✓ 检查**：
- 助手：`Test-Path "$env:LOCALAPPDATA%\Programs\提示词助手\提示词助手.exe"` 为 True，或注册表
  卸载项里有「提示词助手」。
- 插件：解压目录里 manifest.json 存在（`Test-Path "$dest\manifest.json"`），且用户确认扩展卡片
  已出现在浏览器扩展页。
- 两项都过才进阶段 4。

### 阶段 4 · 配置提示词助手侧（lark-cli → 登录 → 数据源），每步检查

#### 4a. 安装 lark-cli 便携版（免 Node/npm，官方 npmmirror 源 + sha256 校验）

```powershell
powershell -ExecutionPolicy Bypass -File "$SKILL\scripts\install-larkcli.ps1"
```

装到 `%APPDATA%\提示词助手\runtime\lark-cli\`（应用内「一键自动配置」同路径，互相识别）。
本机 PATH 已有能跑的 lark-cli 时脚本会自动跳过，直接沿用即可。

**✓ 检查 1（CLI 可用）**：`& "$env:APPDATA\提示词助手\runtime\lark-cli\lark-cli.exe" --version`
输出版本号即通过。

**✓ 检查 2（应用认它）**：应用只认 `config.json` 的 `larkCliPath`，不会自动发现便携版——
必须写入（改前备份；应用正在运行时先退出托盘再写，否则退出时会用内存里的旧配置覆盖）：

```powershell
$cfgFile = "$env:APPDATA\提示词助手\config.json"
if (Test-Path $cfgFile) {
  Copy-Item $cfgFile "$cfgFile.bak" -Force
  $cfg = Get-Content $cfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
  $cfg.larkCliPath = "$env:APPDATA\提示词助手\runtime\lark-cli\lark-cli.exe"
  $cfg | ConvertTo-Json -Depth 20 | Set-Content $cfgFile -Encoding UTF8
} else {
  # 应用从未启动过：先启动一次应用让它生成 config.json，再执行上面的写入
  Start-Process "$env:LOCALAPPDATA%\Programs\提示词助手\提示词助手.exe"
  Start-Sleep 5
}
```

（PATH 已有 npm 版 lark-cli 时可跳过本步写配置——默认值就是它。）

#### 4b. 引导飞书登录（device flow，需要用户本人在浏览器点授权）

```powershell
$cli = "$env:APPDATA\提示词助手\runtime\lark-cli\lark-cli.exe"
# 1) 拿授权链接
& $cli auth login --no-wait --json --domain base,drive
# 2) 打开返回 JSON 里的 verification_url（浏览器弹授权页），提醒用户点授权
# 3) 用户确认已授权后完成登录（device_code 十分钟有效，过期从 1 重来）
& $cli auth login --device-code <第1步返回的device_code> --json
```

**✓ 检查 3（登录态）**：

```powershell
& $cli auth status
```

输出 JSON 里 `identities.user.status == "ready"` 即通过；否则按 troubleshooting.md 处理。
权限域必须是 `base,drive`，身份是 user。

#### 4c. 配置多维表数据源

引导用户：打开提示词助手 → 设置 → 数据源 → 粘贴自己的多维表链接（阶段 5 建好的副本，
全新安装顺序见阶段 5 的前置说明）→ 点「解析」→ 点「立即同步」。表名含「提示词」的表自动接入。

**✓ 检查 4（配置落地 + 数据可达）**：

```powershell
# 1) config.json 里 baseToken 已写入
(Get-Content "$env:APPDATA\提示词助手\config.json" -Raw -Encoding UTF8 | ConvertFrom-Json).baseToken
# 2) 用登录身份实测多维表可读（把 <token> 换成上一步输出）
& $cli base +table-list --base-token <token> --as user
```

两条都出结果（表列表非空）即通过。失败对照 troubleshooting.md（91403 等）。

### 阶段 5 · 配置剪藏插件侧（飞书网页操作 + 插件凭据），并检查

这一步全在飞书网页上进行，**必须用户本人操作**。插件设置页自带带截图的「01 配置指南」，
你的任务是把用户送进去，并守在旁边处理报错。详细字段与权限清单读 `references/feishu-config.md`。
顺序很重要（模板副本 → 应用 → 授权 → 填凭据）：

1. **建多维表副本**：打开剪藏库模板链接（见 feishu-config.md）→ 右上「...」→「创建副本」，
   复制范围选**仅结构**。插件内置审查会拦截直接填模板链接——必须是用户自己的副本。
   （若是全新安装且助手数据源还没配，先完成本步再回阶段 4c。）
2. **建企业自建应用**：[open.feishu.cn/app](https://open.feishu.cn/app) → 创建 → 权限管理开通
   `bitable:app`、`bitable:app:readonly`、`drive:file:upload` → **发布上线**（未发布调不了 API）→
   复制 App ID / App Secret。
3. **给副本加应用**：多维表「...」→「添加文档应用」→ 搜索添加第 2 步的应用，权限设【可编辑】。
4. **配置插件**：任意普通网页点扩展图标 → 浮层右上设置 → 「01 配置指南」分区照截图操作，
   把 App ID / App Secret / 副本链接填进去保存；再到「03 收藏位置」「04 分类与模型」选目标子表、
   点「从飞书同步选项」。

**✓ 检查 5（插件真的能写入）**：引导用户做一个测试剪藏——随便开一个文章网页，点扩展图标 →
选封面、随便写句标题（建议带「测试」二字）→ 保存到飞书。出现「灵感，收好了。」即插件侧通过。

```powershell
# 再用 lark-cli 独立复核：记录真的进表了（<token>=baseToken，<tableId>=+table-list 输出里的目标表 id）
& $cli base +record-list --base-token <token> --table-id <tableId> --limit 5 --json --as user
```

输出里能看到带「测试」标题的记录 → 插件侧全链路（凭据+权限+写入）确认通过。
（lark-cli 输出是 UTF-8 JSON；若控制台显示乱码，重定向到文件再读即可，不影响判断。）
用户剪藏失败或复核看不到记录 → 按 troubleshooting.md（91403/1254030/封面失败）排查。

### 阶段 6 · 端到端验收（三步闭环，全过才算装好）

1. **剪藏写**：阶段 5 的测试记录已验证 ✓。
2. **助手读**：提示词助手 → 设置 → 数据源 → 立即同步 → 卡片里能看到刚剪藏的条目。
3. **一键复制**：托盘右键菜单或面板卡片点一下，剪藏的内容进了剪贴板。

**✓ 最终检查**：三步全部通过后，向用户交付一份简短的「使用说明」：托盘左键开面板、右键常用
菜单、扩展图标剪藏；数据都在他自己的飞书多维表里；日常排障入口——应用内 设置 → 数据源 →
环境自检（应用自带「给 AI 助手的修复指令」按钮，复制给 agent 即可继续排查）。

## 边界与升级维护

- 本 skill 覆盖 Windows x64。macOS：助手暂无 Mac 构建版；插件可装但需用户自行解压加载。
- **版本维护**：日常无需维护——脚本每次安装都实时查 GitHub API 拿最新 release（digest 用 API
  返回的官方值）。仅当希望改善「API 全挂」极端场景的兜底体验时，把 `sources.json` 的
  fallback 节更新为最新已验证版本（tag/asset/digest 用 `gh release view <tag> --json assets` 取）。
- 不要把任何个人多维表地址、App ID/Secret 写进配置或输出日志。App Secret 只应存在于插件设置页
  （本机浏览器存储）里。
