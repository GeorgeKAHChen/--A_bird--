const { app, BrowserWindow, Tray, Menu, screen, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// 本程式畫面很簡單、而且大部分時間靜止，軟體繪製比 GPU 程序省很多記憶體與 CPU（Windows 上實測：私有記憶體約減半）。
// macOS 的合成走系統 Core Animation，保持預設。
if (process.platform === 'win32') app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let tray = null;
let settings = { muted: false, size: 'medium' };
let focusMode = false;   // 專注模式（不存檔，重啟後恢復正常）

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try {
    Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch (_) { /* 第一次啟動沒有設定檔 */ }
}

function saveSettings() {
  try { fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch (_) {}
  send('settings', settings);
}

function send(cmd, data) {
  if (win && !win.isDestroyed()) win.webContents.send('command', cmd, data);
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  win = new BrowserWindow({
    x: wa.x, y: wa.y, width: wa.width, height: wa.height,
    transparent: true, frame: false, hasShadow: false,
    resizable: false, movable: false, fullscreenable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });
  // 整個視窗預設點擊穿透，只有鳥身上才攔截滑鼠（由 renderer 通知切換）
  win.setIgnoreMouseEvents(true, { forward: true });
  win.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
}

function fitToWorkArea() {
  if (!win || win.isDestroyed()) return;
  win.setBounds(screen.getPrimaryDisplay().workArea);
}

function buildMenu() {
  const sizes = [['small', '小'], ['medium', '中'], ['large', '大']];
  return Menu.buildFromTemplate([
    { label: '餵食', click: () => send('feed') },
    { label: '叫一聲', click: () => send('sing') },
    { label: '飛一飛', click: () => send('fly') },
    { label: '睡一會', click: () => send('sleep') },
    { type: 'separator' },
    {
      label: '專注模式（鳥躲到側邊睡覺）', type: 'checkbox', checked: focusMode,
      click: (mi) => { focusMode = mi.checked; send('focus', focusMode); },
    },
    { type: 'separator' },
    {
      label: '靜音', type: 'checkbox', checked: settings.muted,
      click: (mi) => { settings.muted = mi.checked; saveSettings(); },
    },
    {
      label: '大小',
      submenu: sizes.map(([key, label]) => ({
        label, type: 'radio', checked: settings.size === key,
        click: () => { settings.size = key; saveSettings(); },
      })),
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ].filter(Boolean));
}

// 程序生成托盤圖示：白色圓團 + 黑眼睛 + 小嘴（32x32，BGRA）
function makeTrayIcon() {
  const N = 32;
  const buf = Buffer.alloc(N * N * 4);
  const put = (x, y, r, g, b, a) => {
    const i = (y * N + x) * 4;
    buf[i] = b; buf[i + 1] = g; buf[i + 2] = r; buf[i + 3] = a;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - 15, y - 17);
      if (d < 12) put(x, y, 250, 247, 244, 255);
      else if (d < 13.5) put(x, y, 90, 80, 88, 255);
      if (Math.hypot(x - 20, y - 14) < 2.2) put(x, y, 30, 28, 34, 255);
      if (Math.hypot(x - 24.5, y - 16.5) < 1.6) put(x, y, 40, 36, 40, 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: N, height: N, scaleFactor: 2 });
}

app.on('second-instance', () => send('sing'));

app.whenReady().then(() => {
  loadSettings();
  // 本程式不會、也不提供開機自動啟動。若舊版曾經註冊過，這裡移除，避免殘留。
  try { if (app.getLoginItemSettings().openAtLogin) app.setLoginItemSettings({ openAtLogin: false }); } catch (_) {}
  createWindow();
  if (process.platform === 'darwin') app.dock.hide();

  tray = new Tray(makeTrayIcon());
  tray.setToolTip('シマエナガ');
  tray.setContextMenu(buildMenu());
  // 設定改變後重建托盤選單，保持勾選狀態同步
  const refreshTray = () => tray && tray.setContextMenu(buildMenu());
  tray.on('mouse-enter', refreshTray);
  tray.on('click', refreshTray);

  screen.on('display-metrics-changed', fitToWorkArea);
  screen.on('display-added', fitToWorkArea);
  screen.on('display-removed', fitToWorkArea);
});

ipcMain.on('set-ignore', (_e, v) => {
  if (!win || win.isDestroyed()) return;
  if (v) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(false);
});
ipcMain.on('show-menu', () => buildMenu().popup({ window: win || undefined }));
ipcMain.handle('get-settings', () => settings);

app.on('window-all-closed', () => app.quit());
