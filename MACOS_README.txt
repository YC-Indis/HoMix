HoMix 0.20.5 macOS 团队内部版
================================

本包仅供已知来源的团队成员使用，请勿对外转发。

适用机型
--------
- Apple Silicon：M1 / M2 / M3 / M4 等苹果芯片 Mac。
- 本包不支持 Intel Mac。

安装与启动
----------
1. 使用 macOS 自带的“归档实用工具”解压 ZIP。
2. 把 HoMix.app 拖入“应用程序”。
3. 右键点击“先运行这个.command”，选择“打开”。
4. 如果系统再次确认，继续选择“打开”。脚本只会处理 HoMix.app：
   删除它自己的下载隔离属性、执行本机临时签名、校验并启动。
5. 成功运行一次后，后续可直接从“应用程序”打开 HoMix。

如果脚本仍被系统阻止，请打开“终端”，依次执行：

sudo xattr -cr /Applications/HoMix.app
sudo chmod +x /Applications/HoMix.app/Contents/MacOS/HoMix
sudo codesign --force --deep --sign - /Applications/HoMix.app
codesign --verify --deep --strict --verbose=2 /Applications/HoMix.app
open /Applications/HoMix.app

安全说明
--------
- 本包没有 Apple Developer ID 签名与公证，因此只适合受信任的内部团队。
- 脚本不会关闭整台 Mac 的 Gatekeeper，也不会修改其他应用。
- 如果无法确认文件来自团队负责人，请不要运行。

运行说明
--------
- 应用内含 Node.js、FFmpeg 和 FFprobe，不要求另装这些组件。
- Ollama 是可选项，普通启动不会检测或启动；只有使用本地视觉 AI 时才检查。
- 项目和星标库保存在：
~/Library/Application Support/HoMix/Data
- 启动日志保存在：
~/Library/Logs/HoMix/launcher.log
- 从应用菜单退出 HoMix 时，会同步结束后台和正在运行的 FFmpeg 任务。
- 需要 macOS 12 Monterey 或更高版本。

验证范围
--------
收到包后请先在一台团队 Mac 上完成导入、分析、预览、音乐试听和导出测试，
确认无误后再发给其他同事。
