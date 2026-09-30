# 故障排查手册

按症状找条目。每条先给判据，再给修法。修不动时把应用内
设置 → 数据源 → 环境自检 → **「给 AI 助手的修复指令」**按钮的输出发给 agent，里面带机器现状快照。

## 下载与安装

### 下载脚本所有源都失败（退出码 3）

- 判据：`download-artifact.ps1` 报「所有下载源均失败」。
- 顺序检查：①npmmirror 通不通（`curl -sI https://registry.npmmirror.com` 应 200）——
  连它都挂说明是用户网络本身的问题（DNS/代理/防火墙），让用户换热点或网络再试；
  ②镜像偶尔限流，隔几分钟重试或换下一个镜像（ghproxy.net / gh-proxy.com / ghfast.top）；
  ③公司内网可能拦所有非常用域名，让用户开手机热点再跑脚本。
- 80MB 的助手安装包下载中途断：脚本会自动 `--retry 2`；仍失败可手动 curl -C - 断点续传。

### sha256 校验失败（退出码 2）

- 判据：脚本打印的 hash ≠ 期望 digest，文件已自动删除。digest 平时来自 GitHub API 的官方值；
  仅 API 不可达走兜底时才来自 sources.json。
- 通常是镜像返回了错误页/半截文件。重跑一次；复现则换镜像；
  仍复现且走的是兜底模式 → sources.json 的 fallback digest 过期（产品方发了新 release），
  用 `gh release view <tag> -R <repo> --json assets` 核对官方 digest 后修 sources.json。
  动态模式下复现则说明该镜像篡改/污染了文件，换镜像或直连重试。

### 脚本提示「回退兜底旧版」

- 判据：`GitHub API 全部不可达，回退兜底版本`。
- 不是错误：装的是 sources.json 里已验证的旧版，能用。想要最新版就修网络
  （api.github.com 与 gh-proxy.com 至少一个通即可），重跑脚本。

### NSIS 安装向导闪退 / 装完没有托盘图标

- 闪退：杀软拦截或安装目录无写权限——换默认目录（%LOCALAPPDATA% 下不需要管理员）。
- 装完没图标：检查 `%LOCALAPPDATA%\Programs\提示词助手\提示词助手.exe` 是否存在；
  存在则手动启动；托盘图标被系统折叠到「^」溢出区，让用户把图标拖到常驻区。

### 杀毒软件报 lark-cli.exe / 提示词助手.exe

- 二者都是无签名的合法程序，Windows SmartScreen 会弹「更多信息 → 仍要运行」。
- 企业杀软直接隔离 exe 的：把 `%APPDATA%\提示词助手\runtime\` 和安装目录加白名单。

## lark-cli 与登录

### `lark-cli.cmd 不是内部或外部命令`

没装。跑 `install-larkcli.ps1` 即可（阶段 3 本来就会装，说明流程被跳了）。

### `auth status` 输出非 JSON / `Failed to auto-install` / `Cannot find module`

npm 版 lark-cli 装坏了（原生二进制缺失，常见于 npm install 时 GitHub 连不上）。
**修法：删掉坏的，换便携版**——

```powershell
# 找到 npm 版位置删掉，然后跑便携安装脚本
Remove-Item "$env:APPDATA\npm\lark-cli*" -Force
powershell -ExecutionPolicy Bypass -File "$SKILL\scripts\install-larkcli.ps1"
```

### device-flow 登录卡住

- `auth login --no-wait` 没返回 JSON：CLI 版本太老（<1.0.9x），重装便携最新版。
- 用户点了授权但 `--device-code` 完成步骤报错：device_code 十分钟有效，过期就重头走，
  不会产生脏数据。
- 授权页 404 / 打不开：verification_url 域名是 `*.feishu.cn` 或 `*.larksuite.com`（海外账号），
  用户账号所在区决定。国内用户打不开时检查是否开了全局代理把它劫持了。
- `identities.user.status` 不是 ready：授权时域没选全。重新 login，确认命令带
  `--domain base,drive`。

### 助手「环境自检」lark-cli ✓ 但登录 ✗

先 `auth status` 看 JSON；status 是 expired → 重新登录；没有 user 节点 → 登录时身份不对，
用 `--domain base,drive` 重登（别用 bot 身份，助手默认 identity=user）。

## 多维表与同步

### 助手解析多维表链接失败

链接必须是浏览器地址栏完整 URL（含 `/base/<token>`）。分享链接（`/share/...`）解析不出 token，
让用户在多维表页面直接复制地址栏。

### 插件保存报 `91403 NOTEXIST`

- app_token 或表名不对：确认设置页粘的是**自己副本**的链接（不是模板母版）、表名与副本里一致。
- **最常见**：应用没加进副本——多维表「...」→「添加文档应用」→ 添加并设【可编辑】。
- 应用没发布上线也会这样。

### 插件保存报 `1254030` 字段类型不匹配

副本结构被改过（字段名对但类型不对）。对照：封面=附件、链接=超链接、分类=多选、
使用模型=单选。名字完全一致的列被删/改名也会触发。

### 插件封面上传失败

应用缺 `drive:file:upload` 权限，或未发布，或未加进副本。三个条件逐一核对。
个别网站图片有防盗链（返回 403），换一张候选图或「移除封面」只存文字。

### 助手同步成功但看不到剪藏的条目

- 表名不含「提示词」的表**不会**自动接入：设置 → 数据源 → 添加数据表 → 手动选表。
  （剪藏模板的「剪藏」表默认名不含「提示词」——首次要手动添加一次。）
- 字段映射没识别出来：数据源里对那张表点「自动识别字段」。
- 剪藏写进的是「内容」列而表里主字段是「可直接复制提示词」——两边都是识别名单里的列名，
  自动映射会挑到有内容的那个；对不上时在字段映射里手动指一下。

### 助手里图片/视频裂图

媒体附件下载依赖 lark-cli 的 drive 权限（登录域必须含 drive）。重新确认登录时带了
`--domain base,drive`；仍不行看 `%APPDATA%\提示词助手\app.log` 尾部报错。

## 浏览器扩展

### 「加载已解压的扩展程序」是灰的

开发者模式没开（右上角开关）。Edge 的开关在左侧栏，叫「开发人员模式」。

### 扩展图标显示「!」不能剪藏

当前页面是浏览器内部页（chrome://、商店页）或用户拒绝过 host_permissions——
在扩展详情页把「网站访问权限」改回「在所有网站上允许」。

### 更新插件版本

下载新 zip → 解压**覆盖**原扩展目录（保持同一路径）→ 扩展管理页点该扩展的「重新加载」
→ 刷新已打开的网页。设置和已存数据不丢。

### Edge 的差异

- 扩展页地址是 `edge://extensions/`；开发者模式在左下角「扩展」页面的左侧栏里。
- 功能完全一致（同为 Chromium 111+）。360/QQ 浏览器等套壳：能加载但 service worker
  行为偶有差异，出问题时建议换 Chrome/Edge 复现。
