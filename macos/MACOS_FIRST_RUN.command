#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="${0:A:h}"
APP_PATH="$SCRIPT_DIR/HoMix.app"
if [[ ! -d "$APP_PATH" ]]; then
  APP_PATH="/Applications/HoMix.app"
fi

if [[ ! -d "$APP_PATH" ]]; then
  echo "没有找到 HoMix.app。"
  echo "请先把 HoMix.app 拖入‘应用程序’，再重新运行本脚本。"
  echo
  read "?按回车键关闭..."
  exit 1
fi

APP_PATH="${APP_PATH:A}"
if [[ "$APP_PATH" != "$SCRIPT_DIR/HoMix.app" && "$APP_PATH" != "/Applications/HoMix.app" ]]; then
  echo "安全检查失败：应用路径不在安装包或‘应用程序’文件夹中。"
  read "?按回车键关闭..."
  exit 1
fi

echo "正在准备团队内部版：$APP_PATH"
echo "此操作只修改 HoMix.app，不会关闭系统 Gatekeeper。"

EXECUTABLES=(
  "$APP_PATH/Contents/MacOS/HoMix"
  "$APP_PATH/Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework"
  "$APP_PATH/Contents/Frameworks/Electron Helper.app/Contents/MacOS/Electron Helper"
  "$APP_PATH/Contents/Frameworks/Electron Helper (GPU).app/Contents/MacOS/Electron Helper (GPU)"
  "$APP_PATH/Contents/Frameworks/Electron Helper (Plugin).app/Contents/MacOS/Electron Helper (Plugin)"
  "$APP_PATH/Contents/Frameworks/Electron Helper (Renderer).app/Contents/MacOS/Electron Helper (Renderer)"
  "$APP_PATH/Contents/Resources/app/tools/ffmpeg"
  "$APP_PATH/Contents/Resources/app/tools/ffprobe"
)

for executable in "${EXECUTABLES[@]}"; do
  if [[ ! -f "$executable" ]]; then
    echo "应用不完整，缺少：$executable"
    read "?按回车键关闭..."
    exit 1
  fi
  /bin/chmod u+x "$executable" 2>/dev/null || sudo /bin/chmod u+x "$executable"
done

if ! /usr/bin/xattr -cr "$APP_PATH"; then
  echo "需要管理员权限来清理 HoMix.app 的扩展属性。"
  sudo /usr/bin/xattr -cr "$APP_PATH"
fi

if ! /usr/bin/codesign --force --deep --sign - "$APP_PATH"; then
  echo "需要管理员权限来完成 HoMix.app 的本机临时签名。"
  sudo /usr/bin/codesign --force --deep --sign - "$APP_PATH"
fi

/usr/bin/codesign --verify --deep --strict --verbose=2 "$APP_PATH"

echo
echo "准备完成，正在启动 HoMix。"
/usr/bin/open "$APP_PATH"
