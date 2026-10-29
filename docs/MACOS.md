# 小小桌宠 macOS 版（个人自用）

本分支把 Windows 客户端移植到 macOS，仅供个人非商业使用，不对外发布。

## 构建

需要 macOS 自带的 `python3`、`ditto`、`sips`、`iconutil`、`codesign`、`clang`（Xcode Command Line Tools 提供），不需要 Node 或 npm。没有 `clang` 也能构建，只是桌宠不会给全屏应用让位。

```sh
python3 tools/macos/build_macos.py
```

脚本会下载 Electron 43.3.0（darwin-arm64，先试 npmmirror，再试 GitHub，均校验 SHA256），在 `outputs/macos/<时间戳>/` 下生成新的 `小小桌宠.app` 并做本地 ad-hoc 签名。每次都写入新目录，不会覆盖旧构建或 `/Applications`。已经下载好的 Electron 压缩包可用 `--electron-zip` 指定。

## 与 Windows 版的区别

- 数据目录：`~/.dsh/dsh-pet/characters`，客户端设置和日志在 `~/.dsh/pet-control-client`。内置角色的动画只在 .app 里（客户端通过 `DSH_PET_BUNDLED_CHARACTERS` 告诉宿主），`~/.dsh` 里每个角色只有一个配置文件；自己新建 `<角色>/animations` 放进同名片段可以覆盖内置的。旧版本复制出来的、与 .app 相同的片段和人设文件会在启动时自动删掉（精简版不用人设）。
- 宿主服务由 Electron 自带的 Node 运行（`ELECTRON_RUN_AS_NODE`），不附带 `node.exe`；引擎下载 Electron 用的两个依赖换成了空实现，打包后的应用不会下载 Electron。
- 默认只在菜单栏显示（Info.plist 设 `LSUIElement`），Dock 里没有图标。点菜单栏图标可打开控制台、全部开启/隐藏或退出。
- 控制台「在 Dock 栏显示图标」开关（或菜单栏菜单里的同名勾选项）可以把 Dock 图标加回来，设置存在 `~/.dsh/pet-control-client/mac-settings.json`，立即生效。
- 每个角色是一个独立的 Helper 进程，始终不在 Dock 显示。
- 全屏让位：别的应用进入全屏（看视频、演示、游戏、窗口全屏）时，身体一半以上在那块屏上的桌宠会变成全透明且鼠标穿透（透明边缘伸过去不算），退出全屏后恢复；另一块屏上的桌宠不受影响。检测由 `dsh-pet/runtime/electron-helper/macos/fullscreen-watch.c`（构建时编译进 app）每 0.8 秒读一次窗口列表完成，只看窗口位置、层级和所属进程，不需要屏幕录制权限；判定方法与白龙桌宠相同（盖满整块屏的普通窗口 = 全屏，系统进程除外）。拖拽、菜单或对话框开着时先不藏，松手或关掉后再判。设环境变量 `DSH_PET_FULLSCREEN_YIELD=0` 可关闭。
- 上游的 `android/`（安卓版源码和素材）以及黑毛小狐狸（`characters/character5`）、奶茶千金（`characters/character6`）不保留在本仓库；以后合并上游新版本时，这些路径出现冲突就 `git rm -r` 掉。
- 新版本带来的官方新动作会补进已安装的角色：动作名加到 `config.json` 的同一列表；位置、大小、显示状态、分身和自制动作不动。已经提供过的动作记在 `~/.dsh/pet-control-client/offered-actions.json`，您删掉的不会再被加回来。`main` 不参与（配置在 `main-config.jsonc`）。
- 在某个角色身上按 Cmd+Q 只会暂时隐藏它（控制台开关同步变为隐藏）；下次启动应用会自动恢复，也可以随时在控制台重新开启。记录在 `~/.dsh/pet-control-client/quick-hidden.json`。
- 应用菜单提供编辑快捷键（Cmd+C/V/A）；控制台在前台时 Cmd+Q 关闭全部桌宠；开启 Dock 图标时点它也能重新打开控制台。
- 菜单栏图标是从应用图标裁出的彩色小克头像 `client/assets/trayColor.png`（+ `@2x`，26×18pt），由 `tools/macos/tray-icon/make_color_tray_icon.py` 生成。备选的黑白模板剪影 `trayTemplate.png` 由 `make_tray_icon.py` 生成，换回时在 `client/main.cjs` 改文件名并加 `setTemplateImage(true)`。
- AI 密钥用 Electron safeStorage 保存，在 macOS 上由钥匙串加密，首次保存可能弹出钥匙串授权。
- 桌宠不会阻止显示器息屏或系统睡眠。Chromium 默认会给铺满窗口的播放中视频加 Video Wake Lock（静音也加），宠物页和控制台都在 window 捕获阶段截住 video 的 `playing` 事件来避开它。运行时用 `pmset -g assertions` 检查，不应再看到 `Video Wake Lock`。
- `client/verify.cjs`（PowerShell 窗口检查）只适用于 Windows，未打包进 macOS 版。

## Claude Code 工作状态

小克可以跟着本机 Claude Code 的状态换动作：您发消息后翻书碎碎念，开始用工具后对屏碎碎念，等您批准或回答时傲娇碎碎念 / 查看发饰，一轮答完随机播剪刀手 / 欢快舞蹈 / 优雅转圈，出错时生气转身 / 揪头发碎碎念。同时弹一句短话（「在想…」「等您批准」「搞定啦」等，在小克配置的 `workStatusTexts` 里改，六档与动作一一对应；写成空数组 `[]` 就只播动画不弹字）。

```sh
python tools/macos/claude_hooks.py install     # 装 hooks，并在 ~/.dsh 里打开小克的工作状态
python tools/macos/claude_hooks.py status      # 看装了哪些、宿主在不在听
python tools/macos/claude_hooks.py uninstall   # 只删小克自己的 hooks
```

- hooks 全部是异步的 curl，把 hook 的 JSON 发到 `http://127.0.0.1:3081/dsh-pet-7340/claude-hook`，不输出、不做任何决定，与 agent-hud 等其它工具的 hooks（包括阻塞审批的 PermissionRequest）并存。桌宠没开时 curl 立即失败退出，不影响 Claude Code。
- 每次写 `~/.claude/settings.json` 和小克配置前都会备份为 `*.bak-before-little-pet-<时间>`；识别自己的条目只看命令里是否含上面的地址。
- 宿主按会话聚合，多个会话同时在跑时按「等待 > 出错 > 工作 > 思考 > 成功」显示最要紧的一个。按 Esc 打断不会触发 Stop，该会话 10 分钟没有事件后自动回到待机。
- 工作状态是所有桌宠共用的一份，所以只有小克打开：`install` 会把其它角色配置里的 `workStatusEnabled` 改成 false（同样先备份），内置默认也已改为关闭。开关和文案改了不用重启桌宠，下一秒就生效。
- 装完后重启已开着的 Claude Code 会话。

## 安装包（可选）

```sh
# ad-hoc 签名的 .app 加 .dmg
python3 tools/macos/build_macos.py --dmg

# Developer ID 签名（hardened runtime，由内向外逐个签名）+ 公证
xcrun notarytool store-credentials 小小桌宠-notary   # 只需一次，按提示填 Apple ID / Team ID / App 专用密码
python3 tools/macos/build_macos.py --dmg --sign "Developer ID Application: 姓名 (TEAMID)" --notarize 小小桌宠-notary
```

`--notarize` 会提交 .dmg 给 Apple 公证、等待结果并把公证票据钉在 .dmg 上。
