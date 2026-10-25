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
- 默认只在菜单栏显示（Info.plist 设 `LSUIElement`），Dock 里没有图标。点菜单栏图标可打开控制台、全部开启/隐藏或退出。
- 控制台「在 Dock 栏显示图标」开关（或菜单栏菜单里的同名勾选项）可以把 Dock 图标加回来，设置存在 `~/.dsh/pet-control-client/mac-settings.json`，立即生效。
- 每个角色是一个独立的 Helper 进程，始终不在 Dock 显示。
- 在某个角色身上按 Cmd+Q 只会暂时隐藏它（控制台开关同步变为隐藏）；下次启动应用会自动恢复，也可以随时在控制台重新开启。记录在 `~/.dsh/pet-control-client/quick-hidden.json`。
- 应用菜单提供编辑快捷键（Cmd+C/V/A）；控制台在前台时 Cmd+Q 关闭全部桌宠；开启 Dock 图标时点它也能重新打开控制台。
- 菜单栏图标是模板图 `client/assets/trayTemplate.png`（+ `@2x`），系统按浅色/深色菜单栏自动着色；由 `tools/macos/tray-icon/make_tray_icon.py` 生成。
- AI 密钥用 Electron safeStorage 保存，在 macOS 上由钥匙串加密，首次保存可能弹出钥匙串授权。
- `client/verify.cjs`（PowerShell 窗口检查）只适用于 Windows，未打包进 macOS 版。

## 安装包（可选）

```sh
# ad-hoc 签名的 .app 加 .dmg
python3 tools/macos/build_macos.py --dmg

# Developer ID 签名（hardened runtime，由内向外逐个签名）+ 公证
xcrun notarytool store-credentials 小小桌宠-notary   # 只需一次，按提示填 Apple ID / Team ID / App 专用密码
python3 tools/macos/build_macos.py --dmg --sign "Developer ID Application: 姓名 (TEAMID)" --notarize 小小桌宠-notary
```

`--notarize` 会提交 .dmg 给 Apple 公证、等待结果并把公证票据钉在 .dmg 上。
