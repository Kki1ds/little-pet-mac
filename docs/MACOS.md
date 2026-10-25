# 小小桌宠 macOS 版（个人自用）

本分支把 Windows 客户端移植到 macOS，仅供个人非商业使用，不对外发布。

## 构建

需要 macOS 自带的 `python3`、`ditto`、`sips`、`iconutil`、`codesign`（Xcode Command Line Tools 提供），不需要 Node 或 npm。

```sh
python3 tools/macos/build_macos.py
```

脚本会下载 Electron 43.3.0（darwin-arm64，先试 npmmirror，再试 GitHub，均校验 SHA256），在 `outputs/macos/<时间戳>/` 下生成新的 `小小桌宠.app` 并做本地 ad-hoc 签名。每次都写入新目录，不会覆盖旧构建或 `/Applications`。已经下载好的 Electron 压缩包可用 `--electron-zip` 指定。

## 与 Windows 版的区别

- 数据目录：`~/.dsh/dsh-pet/characters`，客户端设置和日志在 `~/.dsh/pet-control-client`。
- 宿主服务由 Electron 自带的 Node 运行（`ELECTRON_RUN_AS_NODE`），不附带 `node.exe`；引擎下载 Electron 用的两个依赖换成了空实现，打包后的应用不会下载 Electron。
- 每个角色是一个独立的 Helper 进程，已从 Dock 隐藏；Dock 里只保留控制台一个图标。
- 应用菜单提供编辑快捷键（Cmd+C/V/A）；Cmd+Q 和 Dock 的「退出」都会关闭全部桌宠；点 Dock 图标重新打开控制台。
- 菜单栏图标使用 `client/assets/app.png`。
- AI 密钥用 Electron safeStorage 保存，在 macOS 上由钥匙串加密，首次保存可能弹出钥匙串授权。
- `client/verify.cjs`（PowerShell 窗口检查）只适用于 Windows，未打包进 macOS 版。
