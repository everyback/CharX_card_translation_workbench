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
let server: WorkbenchServerModule | null = null;
let serverPort: number | null = null;
let shuttingDown = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
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

  if (!existsSync(serverEntry)) throw new Error(`桌面版缺少后端构建产物：${serverEntry}`);
  if (!existsSync(webRoot)) throw new Error(`桌面版缺少前端构建产物：${webRoot}`);

  process.env.WORKBENCH_EMBEDDED = '1';
  process.env.WORKBENCH_HOST = '127.0.0.1';
  process.env.WORKBENCH_DATA_DIR = data;
  process.env.WORKBENCH_WEB_DIR = webRoot;
  process.env.WORKBENCH_NODE_MODULES_DIR = nodeModulesRoot;

  server = await import(pathToFileURL(serverEntry).href) as WorkbenchServerModule;
  let lastError: unknown;
  for (let offset = 0; offset < maxPortAttempts; offset += 1) {
    const port = defaultPort + offset;
    try {
      await server.startWorkbenchServer({ host: '127.0.0.1', port });
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
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(`http://127.0.0.1:${serverPort}/`);
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
