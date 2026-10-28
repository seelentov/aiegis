import { execFile } from 'node:child_process';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { EVENT_CHANNEL, invokeChannel, type ApiImpl, type ApiMethod } from '../shared/api';
import type { AppEvent } from '../shared/types';
import { Core } from './core';
import { resolveAppPaths } from './paths';

let core: Core;
let win: BrowserWindow | null = null;

function api(): ApiImpl {
  return {
    listProjects: () => core.listProjects(),
    pickAndAddProject: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory'], title: 'Выберите git-репозиторий' });
      if (r.canceled || !r.filePaths[0]) return null;
      return core.addProject(r.filePaths[0]);
    },
    removeProject: (id) => core.removeProject(id),

    listJobs: (pid) => core.listJobs(pid),
    listRuns: (pid) => core.listRuns(pid),
    runDetails: (pid, runId) => core.runDetails(pid, runId),
    enqueueTask: (pid, t) => core.enqueueTask(pid, t),
    cancelJob: (pid, jobId) => core.cancelJob(pid, jobId),
    retryJob: (pid, jobId) => core.retryJob(pid, jobId),
    takeOver: (pid, jobId) => core.takeOver(pid, jobId),
    queueState: () => core.queue.state(),
    resumeQueue: () => core.queue.resume(),

    newSession: (pid) => core.newSession(pid),
    openRun: (pid, runId) => core.openRun(pid, runId),
    openExternal: (pid, runId) => core.openExternal(pid, runId),
    openInEditor: (file) => {
      execFile('code', [file], (err) => {
        if (err) execFile('open', ['-a', 'Visual Studio Code', file], () => undefined);
      });
    },

    listTerminals: () => core.terminals.list(),
    terminalSnapshot: (id) => core.terminals.snapshot(id),
    terminalWrite: (id, data) => core.terminals.write(id, data),
    terminalResize: (id, cols, rows) => core.terminals.resize(id, cols, rows),
    terminalClose: (id) => core.terminals.close(id),

    listRoles: (pid) => core.roles(pid),
    defaultTaskRole: (pid) => core.sessionsSettings(pid).default_task_role,
    effectiveConfig: (pid, role) => core.effectiveView(pid, role),
    listConfigFiles: (pid) => core.listConfigFiles(pid),
    readConfigFile: (pid, file) => core.readConfigFile(pid, file),
    writeConfigFile: (pid, file, text) => core.writeConfigFile(pid, file, text),
  };
}

function registerIpc(): void {
  const impl = api();
  for (const name of Object.keys(impl) as ApiMethod[]) {
    const fn = impl[name] as (...a: unknown[]) => unknown;
    ipcMain.handle(invokeChannel(name), async (_e, ...args: unknown[]) => fn(...args));
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1500,
    height: 950,
    title: 'aiegis',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => (win = null));
}

app.whenReady().then(async () => {
  core = new Core(resolveAppPaths(path.join(__dirname, '..', 'defaults')));
  core.on('event', (ev: AppEvent) => win?.webContents.send(EVENT_CHANNEL, ev));
  await core.start();
  registerIpc();
  createWindow();
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  core.shutdown().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
