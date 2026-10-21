#!/usr/bin/env bash
# 在 macOS 上打包「シマエナガ」桌面寵物 → dist/*.dmg
#
# 用法：
#   ./build-mac.sh            # Apple Silicon (arm64) + Intel (x64) 各打一個
#   ./build-mac.sh arm64      # 只打 Apple Silicon
#   ./build-mac.sh x64        # 只打 Intel
#
# 說明：
#   - 沒有 Apple 開發者帳號，所以用 ad-hoc 簽章（codesign -s -），自己的 Mac 上可用；
#     發給別人的話對方第一次要「右鍵 → 打開」，或執行 xattr -cr /Applications/ShimaEnaga.app
#   - 全程只會連網下載 npm 套件與 Electron 執行檔，不上傳任何東西、不讀取你的簽章憑證 / 鑰匙圈。
set -euo pipefail

APP_NAME="ShimaEnaga"
ARCHS=("arm64" "x64")
case "${1:-all}" in
  all) ;;
  arm64|x64) ARCHS=("$1") ;;
  *) echo "用法: $0 [arm64|x64]" >&2; exit 1 ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ 這個腳本只能在 macOS 上執行（Windows / Linux 做不出可運行的 Mac 版）" >&2
  exit 1
fi
for cmd in node npm codesign hdiutil; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "❌ 找不到 $cmd。Node.js 請先安裝（https://nodejs.org，建議 LTS 20 以上）" >&2; exit 1; }
done

cd "$(dirname "$0")"

# 不要自動尋找 / 使用本機的簽章憑證，避免跳出鑰匙圈授權視窗
export CSC_IDENTITY_AUTO_DISCOVERY=false

echo "▶ 安裝依賴…"
npm install --no-audit --no-fund

# 新版 npm 預設不執行安裝腳本，Electron 執行檔可能沒下載，這裡直接補上
if [[ ! -d node_modules/electron/dist/Electron.app ]]; then
  echo "▶ 下載 Electron 執行檔…"
  node node_modules/electron/install.js
fi

rm -rf dist
mkdir -p dist

for arch in "${ARCHS[@]}"; do
  echo "▶ 打包 $arch …"
  npx electron-builder --mac dir "--$arch"

  # electron-builder 的輸出目錄：x64 為 dist/mac，arm64 為 dist/mac-arm64
  if [[ "$arch" == "arm64" ]]; then dir="dist/mac-arm64"; else dir="dist/mac"; fi
  app="$dir/$APP_NAME.app"
  [[ -d "$app" ]] || { echo "❌ 找不到 $app" >&2; exit 1; }

  echo "▶ ad-hoc 簽章 $arch …"
  codesign --force --deep --sign - "$app"

  echo "▶ 製作 dmg ($arch) …"
  stage="$(mktemp -d)"
  cp -R "$app" "$stage/"
  ln -s /Applications "$stage/Applications"
  hdiutil create -volname "$APP_NAME" -srcfolder "$stage" -ov -format UDZO "dist/$APP_NAME-1.0.0-$arch.dmg" >/dev/null
  rm -rf "$stage"
done

# 清掉中間產物，只留下 dmg
rm -rf dist/mac dist/mac-arm64 dist/builder-debug.yml dist/builder-effective-config.yaml

echo
echo "✅ 完成："
ls -lh dist/*.dmg
echo
echo "第一次開啟若被擋：右鍵 App →「打開」，或  xattr -cr /Applications/$APP_NAME.app"
