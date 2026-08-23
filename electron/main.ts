import { app, BrowserWindow, dialog } from 'electron';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface WorkbenchServerModule {
  startWorkbenchServer(options?: { host?: string; port?: number }): Promise<{
    address: string;
    host: string;
    port: number;
  }>;
  stopWorkbenchServer(): Promise<void>;
}

const currentFile = fileURLToPath(import.meta.url);
const currentDirectory = path.dirname(currentFile);
const defaultPort = 8787;
const maxPortAttempts = 20;

let mainWindow: BrowserWindow | null = null;
let loadingWindow: BrowserWindow | null = null;
let server: WorkbenchServerModule | null = null;
let serverPort: number | null = null;
let shuttingDown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const activeWindow = mainWindow ?? loadingWindow;
    if (!activeWindow) return;
    if (activeWindow.isMinimized()) activeWindow.restore();
    activeWindow.focus();
  });

  app.whenReady().then(boot).catch(handleFatalError);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    void shutdown();
  });
}

function applicationRoot(): string {
  return app.isPackaged ? app.getAppPath() : path.resolve(currentDirectory, '..');
}

function dataRoot(): string {
  const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableRoot) return path.join(path.resolve(portableRoot), 'data');
  return path.join(app.getPath('userData'), 'data');
}

async function boot(): Promise<void> {
  app.setAppUserModelId('com.cardloom.translate');

  const root = applicationRoot();
  const data = dataRoot();
  const serverEntry = path.join(root, 'dist-server', 'server', 'index.js');
  const webRoot = path.join(root, 'dist');
  const nodeModulesRoot = path.join(root, 'node_modules');

  loadingWindow = createLoadingWindow();
  loadingWindow.on('closed', () => { loadingWindow = null; });
  await loadingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingPage())}`);
  loadingWindow.show();
  updateLoading(5, '准备启动本地工作台');

  await loadingStage(8, 16, '检查桌面资源', async () => {
    if (!existsSync(serverEntry)) throw new Error(`桌面版缺少后端构建产物：${serverEntry}`);
    if (!existsSync(webRoot)) throw new Error(`桌面版缺少前端构建产物：${webRoot}`);
  });

  process.env.WORKBENCH_EMBEDDED = '1';
  process.env.WORKBENCH_HOST = '127.0.0.1';
  process.env.WORKBENCH_DATA_DIR = data;
  process.env.WORKBENCH_WEB_DIR = webRoot;
  process.env.WORKBENCH_NODE_MODULES_DIR = nodeModulesRoot;

  await loadingStage(16, 48, '初始化本地数据库', async () => {
    server = await import(pathToFileURL(serverEntry).href) as WorkbenchServerModule;
  });

  await loadingStage(48, 78, '启动本地服务', async () => {
    let lastError: unknown;
    for (let offset = 0; offset < maxPortAttempts; offset += 1) {
      const port = defaultPort + offset;
      try {
        await server!.startWorkbenchServer({ host: '127.0.0.1', port });
        serverPort = port;
        break;
      } catch (error) {
        lastError = error;
        if (!isAddressInUse(error)) throw error;
      }
    }
    if (serverPort === null) {
      throw new Error(`无法找到可用的本机端口（${defaultPort}-${defaultPort + maxPortAttempts - 1}）。`, { cause: lastError });
    }
  });

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    backgroundColor: '#f4f6f8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  await loadingStage(78, 98, '加载工作台界面', async () => {
    await mainWindow!.loadURL(`http://127.0.0.1:${serverPort}/`);
  });

  updateLoading(100, '初始化完成');
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
  loadingWindow = null;
  mainWindow.show();
}

function createLoadingWindow(): BrowserWindow {
  return new BrowserWindow({
    width: 560,
    height: 360,
    minWidth: 560,
    minHeight: 360,
    maxWidth: 560,
    maxHeight: 360,
    resizable: false,
    center: true,
    show: false,
    backgroundColor: '#f4f6f8',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
}

function updateLoading(percent: number, message: string): void {
  const window = loadingWindow;
  if (!window || window.isDestroyed()) return;
  const script = `window.__updateLoading?.(${Math.max(0, Math.min(100, percent))}, ${JSON.stringify(message)});`;
  void window.webContents.executeJavaScript(script, true).catch(() => undefined);
}

async function loadingStage<T>(start: number, target: number, message: string, task: () => Promise<T>): Promise<T> {
  let current = start;
  updateLoading(current, message);
  const timer = setInterval(() => {
    current = Math.min(target - 1, current + 1);
    updateLoading(current, message);
  }, 140);
  try {
    return await task();
  } finally {
    clearInterval(timer);
    updateLoading(target, message);
  }
}

function loadingPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>CardLoom Translate</title>
  <style>
    :root { color-scheme: light; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 360px; display: grid; place-items: center; color: #21302e; background: #f4f6f8; }
    main { width: 100%; padding: 42px 52px 38px; }
    .brand { display: flex; align-items: center; gap: 14px; }
    .mark { width: 42px; height: 42px; display: grid; place-items: center; border-radius: 12px; color: #fff; background: #2f8579; font-size: 22px; font-weight: 700; box-shadow: 0 5px 14px rgba(47,133,121,.2); }
    h1 { margin: 0; font-size: 22px; letter-spacing: 0; font-weight: 700; }
    .subtitle { margin: 5px 0 0; color: #74817f; font-size: 13px; }
    .progress-area { margin-top: 42px; }
    .status-row { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
    .status { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #53615f; font-size: 14px; }
    .percent { flex: 0 0 auto; color: #2f8579; font-size: 14px; font-variant-numeric: tabular-nums; font-weight: 700; }
    .track { height: 8px; margin-top: 12px; overflow: hidden; border-radius: 99px; background: #dce6e4; }
    .bar { width: 0; height: 100%; border-radius: inherit; background: #2f8579; transition: width .18s ease-out; }
    .footnote { margin: 25px 0 0; color: #9aa5a3; font-size: 12px; }
  </style>
</head>
<body>
  <main>
    <div class="brand">
      <div class="mark">译</div>
      <div><h1>CardLoom Translate</h1><p class="subtitle">CharX 卡片翻译工作台</p></div>
    </div>
    <section class="progress-area" aria-live="polite">
      <div class="status-row"><div id="status" class="status">准备启动本地工作台</div><div id="percent" class="percent">0%</div></div>
      <div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div id="bar" class="bar"></div></div>
    </section>
    <p class="footnote">首次启动会依次检查桌面资源、初始化本地数据库、启动本地服务并加载工作台，整个过程可能需要一些时间，请耐心等待。</p>
  </main>
  <script>
    window.__updateLoading = (percent, message) => {
      const value = Math.max(0, Math.min(100, Number(percent) || 0));
      document.getElementById('bar').style.width = value + '%';
      document.getElementById('percent').textContent = Math.round(value) + '%';
      document.getElementById('status').textContent = message;
      document.querySelector('[role="progressbar"]').setAttribute('aria-valuenow', String(Math.round(value)));
    };
  </script>
</body>
</html>`;
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await server?.stopWorkbenchServer();
  } catch (error) {
    console.error('关闭本地工作台服务失败。', error);
  } finally {
    app.exit(0);
  }
}

async function handleFatalError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  console.error(error);
  if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
  await dialog.showMessageBox({
    type: 'error',
    title: 'CardLoom Translate 启动失败',
    message: '工作台无法启动。',
    detail: message,
  });
  app.quit();
}

function isAddressInUse(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EADDRINUSE');
}
