const { app, BrowserWindow, dialog, ipcMain, Menu, shell } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const APP_NAME = 'HoMix';
const DEFAULT_PORT = 47821;
let mainWindow = null;
let serverProcess = null;
let shuttingDown = false;

app.setName(APP_NAME);
if (!app.requestSingleInstanceLock()) app.quit();

function appRoot() {
  return app.getAppPath();
}

function writeLog(message) {
  try {
    const logDir = app.getPath('logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'launcher.log'), `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {}
}

function portAvailable(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}

async function choosePort() {
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 100; port += 1) {
    if (await portAvailable(port)) return port;
  }
  throw new Error('找不到可用的本地端口');
}

function runtimePath(name) {
  return path.join(appRoot(), 'tools', name);
}

function dataPath() {
  return path.join(app.getPath('userData'), 'Data');
}

function migrateLegacyData() {
  const target = dataPath();
  const legacy = path.join(app.getPath('appData'), 'SceneSift', 'Data');
  const projects = path.join(target, 'projects');
  const hasData = fs.existsSync(path.join(target, 'ai-config.json'))
    || fs.existsSync(path.join(target, 'library.json'))
    || (fs.existsSync(projects) && fs.readdirSync(projects).some((file) => file.endsWith('.json')));
  if (!hasData && fs.existsSync(legacy)) fs.cpSync(legacy, target, { recursive: true });
}

function startServer(port) {
  const serverScript = path.join(appRoot(), 'server.js');
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HOMIX_NO_BROWSER: '1',
    HOMIX_PORT: String(port),
    HOMIX_DATA_DIR: dataPath(),
    HOMIX_FFMPEG: runtimePath('ffmpeg'),
    HOMIX_FFPROBE: runtimePath('ffprobe'),
  };
  serverProcess = spawn(process.execPath, [serverScript], {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (data) => writeLog(data.toString('utf8').trimEnd()));
  serverProcess.stderr.on('data', (data) => writeLog(`ERROR ${data.toString('utf8').trimEnd()}`));
  serverProcess.on('error', (error) => writeLog(`后台启动失败：${error.stack || error.message}`));
  serverProcess.on('exit', (code, signal) => {
    writeLog(`后台退出：code=${code} signal=${signal}`);
    serverProcess = null;
    if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) {
      dialog.showErrorBox('HoMix 后台已停止', '请关闭应用后重新打开。详细信息已写入日志。');
    }
  });
}

async function waitForServer(port) {
  const endpoint = `http://127.0.0.1:${port}/api/health`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (!serverProcess) throw new Error('后台进程提前退出');
    try {
      const response = await fetch(endpoint, { cache: 'no-store' });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('后台启动超时');
}

function stopServer() {
  if (!serverProcess?.pid) return;
  const pid = serverProcess.pid;
  shuttingDown = true;
  serverProcess = null;
  try { process.kill(-pid, 'SIGTERM'); } catch {
    try { process.kill(pid, 'SIGTERM'); } catch {}
  }
  writeLog(`已结束后台进程组：${pid}`);
}

function sendMenuCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('homix-native-message', { type: 'menu-command', command });
}

function installApplicationMenu() {
  const template = [
    {
      label: APP_NAME,
      submenu: [
        { role: 'about', label: `关于 ${APP_NAME}` },
        { type: 'separator' },
        { label: '识别设置…', accelerator: 'CmdOrCtrl+,', click: () => sendMenuCommand('ai-settings') },
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: `隐藏 ${APP_NAME}` },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: `退出 ${APP_NAME}` },
      ],
    },
    {
      label: '文件',
      submenu: [
        { label: '新建项目', accelerator: 'CmdOrCtrl+N', click: () => sendMenuCommand('new-project') },
        { label: '添加视频…', accelerator: 'CmdOrCtrl+O', click: () => sendMenuCommand('pick-files') },
        { type: 'separator' },
        { label: '本地项目', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendMenuCommand('open-projects') },
        { label: '星标素材库', accelerator: 'CmdOrCtrl+Shift+L', click: () => sendMenuCommand('open-library') },
        { type: 'separator' },
        { role: 'close', label: '关闭窗口' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '显示',
      submenu: [
        { label: '切换侧边栏', accelerator: 'CmdOrCtrl+Control+S', click: () => sendMenuCommand('toggle-sidebar') },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '前置全部窗口' },
      ],
    },
    {
      role: 'help',
      label: '帮助',
      submenu: [
        { label: '使用说明', click: () => sendMenuCommand('show-help') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1440,
    height: 930,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#161618',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 17, y: 17 },
    acceptFirstMouse: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('close', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(`http://127.0.0.1:${port}/?desktop=macos`);
}

const pickerOptions = {
  'pick-files': { properties: ['openFile', 'multiSelections'], filters: [{ name: '视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mts', 'm2ts'] }], reply: 'files-picked' },
  'pick-video-folder': { properties: ['openDirectory'], reply: 'video-folder-picked' },
  'pick-output-folder': { properties: ['openDirectory', 'createDirectory'], reply: 'output-folder-picked' },
  'pick-hook-file': { properties: ['openFile', 'multiSelections'], filters: [{ name: '钩子视频', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'mts', 'm2ts'] }], reply: 'hook-file-picked' },
  'pick-music-file': { properties: ['openFile', 'multiSelections'], filters: [{ name: '音乐', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'wma', 'mp4'] }], reply: 'music-files-picked' },
};

ipcMain.on('homix-native-command', async (event, command) => {
  const options = pickerOptions[String(command || '')];
  if (!options) return;
  const result = await dialog.showOpenDialog(mainWindow, options);
  if (!event.sender.isDestroyed()) event.sender.send('homix-native-message', { type: options.reply, paths: result.canceled ? [] : result.filePaths });
});

app.on('second-instance', () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.on('activate', () => {
  if (mainWindow) mainWindow.show();
});

app.on('before-quit', stopServer);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.whenReady().then(async () => {
  try {
    app.setAboutPanelOptions({
      applicationName: APP_NAME,
      applicationVersion: app.getVersion(),
      copyright: '本地视频工作台',
    });
    installApplicationMenu();
    migrateLegacyData();
    const port = await choosePort();
    startServer(port);
    await waitForServer(port);
    createWindow(port);
  } catch (error) {
    writeLog(error.stack || error.message);
    dialog.showErrorBox('HoMix 无法启动', `${error.message}\n\n请查看：${path.join(app.getPath('logs'), 'launcher.log')}`);
    app.quit();
  }
});
