# 一站式安装 Skill：提示词助手 × 网页剪藏插件

把这个 skill 交给 ZCode（或兼容 agent），它就会引导你把两个产品一次装好、配好：

- **提示词助手** — Windows 托盘提示词速查/一键复制工具（数据来自你的飞书多维表）
- **网页剪藏插件** — 浏览器扩展，把网页上的提示词/图片/视频一键剪藏进飞书多维表

```
浏览器剪藏插件 ──写入──▶ 你的飞书多维表 ──同步──▶ 提示词助手（托盘速查/复制）
```

全程只用你自己的飞书账号，不需要任何付费服务；agent 会自动下载安装包（带 sha256 校验、
国内镜像加速）、安装 lark-cli、引导你完成飞书授权，剩下需要你亲手点的操作它会给逐步指引。

## 怎么安装这个 skill

### 方式一：放个人技能目录（推荐，所有项目都能用）

把 `prompt-assistant-setup` 整个文件夹复制到：

```
Windows: %USERPROFILE%\.agents\skills\prompt-assistant-setup\
即:      C:\Users\<你的用户名>\.agents\skills\prompt-assistant-setup\
```

重启 ZCode，对它说「安装提示词助手和剪藏插件」即可触发。

### 方式二：放某个项目里（只在那个项目目录下可用）

复制到 `<项目>\.agents\skills\prompt-assistant-setup\`。

### 方式三：一次性使用（不装）

把整个文件夹放进任意目录，在 ZCode 里直接说：

> 读 `<文件夹路径>\SKILL.md`，按它引导我把两个产品装好

## 系统要求

- Windows 10/11 x64（提示词助手仅支持 Windows）
- Chrome 或 Edge 浏览器（装剪藏插件用）
- 一个飞书账号（个人版即可，免费）
- 磁盘约 2GB、能访问国内网络（GitHub 直连不通也没关系，脚本自动走镜像）

## 装好后你会得到什么

1. 右下角托盘的提示词助手：左键开吸附面板、右键常用提示词菜单、点卡片即复制全文
2. 浏览器里的剪藏插件：任意网页点图标 → 选封面/编辑提示词 → 存进你的飞书多维表
3. 两者通过你的飞书多维表副本互通：网页上剪藏的，托盘里马上能搜到、复制

## 装坏了/重装/换电脑

对 agent 说「重新跑一遍提示词助手安装 skill」即可；已经建好的飞书副本和企业自建应用
不用重建，agent 会检测到并跳过重复步骤。应用内 设置 → 数据源 → 环境自检 也有
「给 AI 助手的修复指令」按钮，一键生成排查指令发给 agent。

## 文件结构

```
prompt-assistant-setup/
├── SKILL.md                        # agent 主流程（6 阶段引导）
├── sources.json                    # 仓库/资产规则 + API 不可达时的兜底版本
├── README.md                       # 本文件（给人看的）
├── scripts/
│   ├── check-env.ps1               # 环境预检（只读，含网络探测）
│   ├── download-artifact.ps1       # 实时查 GitHub 最新版 → 下载 → sha256 校验 + 镜像回退
│   └── install-larkcli.ps1         # lark-cli 便携安装（npmmirror 官方源）
└── references/
    ├── products.md                 # 两个产品的形态与数据契约
    ├── feishu-config.md            # 飞书侧配置详解（副本/应用/权限/登录原理)
    └── troubleshooting.md          # 按症状排查手册
```

**升级到最新版**：什么都不用做。下载脚本每次运行都实时查 GitHub 最新 release（官方 API 取
版本号和 sha256，直连不通自动走镜像）。只有 GitHub API 完全不可达的极端情况才会装
sources.json 里记录的兜底旧版，并在输出里明确提示。

## 隐私与安全

- 下载脚本带 sha256 校验（对 GitHub 官方 release digest），校验不过不安装
- lark-cli 是飞书官方 CLI，从 npmmirror 官方镜像下载并校验
- 你的飞书凭据只存在本机：App Secret 在浏览器扩展存储里，登录 token 在本机 lark-cli 数据目录
- 两个产品均为 MIT 开源：<https://github.com/EConG37/prompt-assistant> ·
  <https://github.com/EConG37/feishu-web-clipper>
