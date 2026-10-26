# 小小桌宠

Windows 桌面宠物客户端，当前版本 **v1.0.5**。

基于 **[PC2005-cloud](https://github.com/PC2005-cloud)** 的 **[dsh-pet](https://github.com/PC2005-cloud/dsh-pet)** 改造，感谢原作者提供桌宠引擎，保留原 MIT 许可。新增角色、动画和图标由本项目作者创作。

## Windows 下载

**[下载最新版完整客户端 Windows 64位 解压即用](https://github.com/yshuang722-spec/xiaoxiao-zhuochong/releases/latest/download/xiaoxiao-zhuochong-win-x64-portable.zip)**

新用户右键“全部解压”，进入“小小桌宠”文件夹，双击“小小桌宠.exe”。保留完整文件夹，无需另装 Node、npm 或 Python。

**[已有客户端 下载 v1.0.5 更新包](https://github.com/yshuang722-spec/xiaoxiao-zhuochong/releases/download/v1.0.5/xiaoxiao-zhuochong-1.0.5-update.zip)** · [更新步骤与常见问题](docs/UPDATE-1.0.5.md)

完整解压更新包，从托盘退出桌宠，双击 update.cmd，选择原程序 EXE 所在文件夹；完成后用原快捷方式启动。适用于官方 v1.0.3、v1.0.4。

## 本版内容

本仓库（Mac 自用版）保留四个角色：蓝毛小女仆、小克（橙毛大小姐重绘）、黄毛该溜子、白毛小龙娘。上游的黑毛小狐狸与奶茶千金未收录。

- 蓝毛小女仆：106 段。
- 橙毛大小姐：19 段。
- 黄毛该溜子：12 段。
- 白毛小龙娘：12 段。

- 角色独立显示与隐藏，支持全部开启、全部隐藏。
- 小动作点播和轮播、拖动弹跳、角色间碰撞、播放错误与停滞恢复。
- 每个角色最多额外添加8个分身，在原角色的分身管理内操作；本体及分身可独立调大小。
- 各角色的人设与聊天历史分开保存，共用用户设置的 AI 接口；持续对话窗口和头顶回复气泡。
- 更新界面与托盘使用当前角色图标，保留已有客户端的对话和设置入口。
- 角色运行及调整日志，自动清理超过十天的旧日志。
- 关闭控制页后宠物继续运行，通过托盘重新打开或退出全部。

角色数据位于 `%USERPROFILE%\.dsh\dsh-pet\characters`。


## 源码与构建

Windows 客户端在 `client/`，六角色配置、成品动画和人设在 `characters/`。实际运行的引擎 JavaScript 在 `dsh-pet/lib/` 与 `dsh-pet/runtime/`，同时保留原 TypeScript 源码；直接重编原 TypeScript 会覆盖本项目已有集成改动。


Windows 可使用 `tools/client-release/build-1.0.5.py` 配合已有 Electron 与 Node 运行环境构建。GitHub 自动生成的 Source code 是源码；直接使用请下载上面的完整客户端 ZIP。

[完整使用步骤与常见问题](使用说明.md) · [本版动作列表](docs/RELEASE-CONTENT-1.0.5.json)
