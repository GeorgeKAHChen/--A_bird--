#!/usr/bin/env bash
# macOS 性能測試：量「シマエナガ」桌面寵物（含 Electron 的 GPU / Renderer / 輔助程序）的 CPU 與記憶體。
#
# 用法：
#   ./perf-mac.sh                          # 用原始碼啟動（需先 npm install），預熱 30 秒後取樣 30 秒
#   ./perf-mac.sh --app /Applications/ShimaEnaga.app   # 量已打包好的 App
#   ./perf-mac.sh --manual                 # 啟動後暫停，讓你先把鳥調到想量的狀態（見下）再按 Enter 開始取樣
#   ./perf-mac.sh --attach 12345           # 不啟動，直接量一個已在跑的程序（及其子程序）
#   選項：--warm 秒數（預設 30）  --sample 秒數（預設 30）
#
# 想量的狀態（用 --manual，在預熱期間右鍵點鳥操作）：
#   睡覺      選單 →「睡一會」，等鳥飛到角落睡著（約 10 秒）
#   專注模式  托盤選單 →「專注模式」
#   一直在飛  連續點選單「飛一飛」，或對鳥雙擊
#   不操作    什麼都不做（鳥會發呆，1~2 分鐘後自己去睡）
#
# 輸出：每個程序的 CPU%（占「單一核心」的百分比，取樣期間的平均）、RSS、Footprint（和「活動監視器」的記憶體欄位最接近）。
# 本腳本只讀取 ps / footprint 的資訊，不上傳、不修改任何東西；結束時會關掉它自己啟動的程序。
# 參考（Windows 實測，1920x1080）：睡覺約 1% CPU / 130 MB；發呆約 3~5% / 130~150 MB；一直在飛約 36% / 165 MB。
set -euo pipefail

WARM=30
SAMPLE=30
APP=""
ATTACH=""
MANUAL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP="${2:?--app 需要 .app 路徑}"; shift 2 ;;
    --attach) ATTACH="${2:?--attach 需要 PID}"; shift 2 ;;
    --warm) WARM="${2:?}"; shift 2 ;;
    --sample) SAMPLE="${2:?}"; shift 2 ;;
    --manual) MANUAL=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知選項：$1（用 --help 看說明）" >&2; exit 1 ;;
  esac
done

SELF_PID=""
cleanup() {
  if [[ -n "$SELF_PID" ]] && kill -0 "$SELF_PID" 2>/dev/null; then
    # 連同子程序一起關掉（只關我們自己啟動的）
    pkill -P "$SELF_PID" 2>/dev/null || true
    kill "$SELF_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

ROOT=""
if [[ -n "$ATTACH" ]]; then
  ROOT="$ATTACH"
  kill -0 "$ROOT" 2>/dev/null || { echo "❌ 找不到 PID $ROOT" >&2; exit 1; }
elif [[ -n "$APP" ]]; then
  [[ -d "$APP" ]] || { echo "❌ 找不到 $APP" >&2; exit 1; }
  BIN="$(ls "$APP/Contents/MacOS/"* 2>/dev/null | head -n 1 || true)"
  [[ -x "$BIN" ]] || { echo "❌ $APP 裡找不到可執行檔" >&2; exit 1; }
  "$BIN" >/dev/null 2>&1 &
  SELF_PID=$!
  ROOT="$SELF_PID"
else
  cd "$(dirname "$0")"
  ELECTRON="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
  [[ -x "$ELECTRON" ]] || { echo "❌ 找不到 Electron，請先在專案目錄執行 npm install" >&2; exit 1; }
  "$ELECTRON" . >/dev/null 2>&1 &
  SELF_PID=$!
  ROOT="$SELF_PID"
fi

# 列出 ROOT 及其所有子孫程序：  pid  類型  累計CPU秒  RSS(KB)
snap() {
  ps -axo pid=,ppid=,cputime=,rss=,command= | awk -v root="$ROOT" '
    function secs(t,   n, a) {
      n = split(t, a, ":")
      if (n == 3) return a[1] * 3600 + a[2] * 60 + a[3]
      if (n == 2) return a[1] * 60 + a[2]
      return a[1] + 0
    }
    {
      pid = $1; ppid = $2
      cmd = $0
      sub(/^ *[0-9]+ +[0-9]+ +[^ ]+ +[0-9]+ +/, "", cmd)
      P[NR] = pid; PP[pid] = ppid; C[pid] = secs($3); R[pid] = $4; M[pid] = cmd; n = NR
    }
    END {
      keep[root] = 1; changed = 1
      while (changed) {
        changed = 0
        for (i = 1; i <= n; i++) {
          p = P[i]
          if (!(p in keep) && (PP[p] in keep)) { keep[p] = 1; changed = 1 }
        }
      }
      for (p in keep) {
        t = "browser"
        if (M[p] ~ /--type=gpu-process/) t = "gpu"
        else if (M[p] ~ /--type=renderer/) t = "renderer"
        else if (M[p] ~ /--type=utility/) t = (M[p] ~ /network/ ? "network" : "utility")
        else if (p != root) t = "other"
        printf "%s %s %.2f %d\n", p, t, C[p], R[p]
      }
    }'
}

# Footprint（MB）：macOS 10.15+ 內建的 footprint 工具，和活動監視器的「記憶體」最接近；沒有就回傳 -
footprint_mb() {
  command -v footprint >/dev/null 2>&1 || { echo "-"; return; }
  footprint -p "$1" 2>/dev/null | awk '
    /Footprint:/ {
      for (i = 1; i <= NF; i++) if ($i == "Footprint:") { v = $(i + 1); u = $(i + 2) }
      if (u ~ /^KB/) v = v / 1024; else if (u ~ /^GB/) v = v * 1024
      printf "%.0f", v; found = 1; exit
    }
    END { if (!found) printf "-" }'
}

echo "▶ 程序 $ROOT 已啟動，預熱 ${WARM} 秒…"
if [[ "$MANUAL" == 1 ]]; then
  echo "  --manual：請現在操作鳥到想量的狀態，完成後按 Enter 開始取樣。"
  read -r _
else
  sleep "$WARM"
fi

kill -0 "$ROOT" 2>/dev/null || { echo "❌ 程序已結束（可能崩潰了）" >&2; exit 1; }

A="$(mktemp)"; B="$(mktemp)"
trap 'rm -f "$A" "$B"; cleanup' EXIT
snap > "$A"
T0=$(date +%s)
echo "▶ 取樣 ${SAMPLE} 秒…"
sleep "$SAMPLE"
snap > "$B"
T1=$(date +%s)
EL=$((T1 - T0)); [[ "$EL" -lt 1 ]] && EL=1

echo
printf '%-10s %-8s %8s %10s %12s\n' "type" "pid" "CPU%" "RSS(MB)" "Footprint(MB)"
TOT_CPU=0; TOT_RSS=0; TOT_FP=0
while read -r pid type cpu_b rss_kb; do
  cpu_a="$(awk -v p="$pid" '$1 == p { print $3 }' "$A")"
  if [[ -n "$cpu_a" ]]; then
    cpu_pct="$(awk -v a="$cpu_a" -v b="$cpu_b" -v e="$EL" 'BEGIN { printf "%.1f", (b - a) / e * 100 }')"
  else
    cpu_pct="0.0"
  fi
  rss_mb="$(awk -v k="$rss_kb" 'BEGIN { printf "%.0f", k / 1024 }')"
  fp="$(footprint_mb "$pid")"
  printf '%-10s %-8s %7s%% %10s %12s\n' "$type" "$pid" "$cpu_pct" "$rss_mb" "$fp"
  TOT_CPU="$(awk -v a="$TOT_CPU" -v b="$cpu_pct" 'BEGIN { printf "%.1f", a + b }')"
  TOT_RSS=$((TOT_RSS + rss_mb))
  [[ "$fp" != "-" ]] && TOT_FP=$((TOT_FP + fp))
done < <(sort -k2,2 -k1,1n "$B")

echo "------------------------------------------------------------"
FPOUT="$TOT_FP"; [[ "$TOT_FP" == 0 ]] && FPOUT="-"
printf '%-10s %-8s %7s%% %10s %12s\n' "TOTAL" "" "$TOT_CPU" "$TOT_RSS" "$FPOUT"
echo "（CPU% 為占單一核心的百分比；100% = 用滿一顆核心。取樣 ${EL} 秒。）"
