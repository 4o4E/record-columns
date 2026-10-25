'use strict';

const { BrowserWindow, ipcMain, screen } = require('electron');
const { randomUUID } = require('node:crypto');

const pending = new Map();
const CONFIG_KEY = 'record-columns';
const DEFAULT_CONFIG = { enabled: true };

function isEnabled() {
  return LiteLoader.api.config.get(CONFIG_KEY, DEFAULT_CONFIG).enabled !== false;
}

function broadcastEnabled(enabled) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('record-columns:enabled', enabled);
  }
}

ipcMain.handle('record-columns:get-enabled', () => isEnabled());
ipcMain.handle('record-columns:set-enabled', (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new TypeError('开关状态必须为布尔值');
  const current = LiteLoader.api.config.get(CONFIG_KEY, DEFAULT_CONFIG);
  if (LiteLoader.api.config.set(CONFIG_KEY, { ...current, enabled }) !== true) {
    throw new Error('保存多列聊天记录设置失败');
  }
  broadcastEnabled(enabled);
  return enabled;
});


function enabledFor(event) {
  return isEnabled() && isRecordWindow(event.sender);
}
const expanded = new WeakSet();

function isRecordWindow(contents) {
  return contents.getURL().startsWith('app://./renderer/index.html') &&
    contents.getURL().includes('#/forward/');
}

// 联系人选择属于 QQ 主窗口。桥接只传递选中的消息，不执行任意脚本或接受发送目标。
ipcMain.handle('record-columns:forward', (event, payload) => {
  if (!enabledFor(event)) throw new Error('多列聊天记录已关闭或请求来源无效');
  const source = event.sender;
  const target = BrowserWindow.getAllWindows().find(window =>
    !window.isDestroyed() && window.webContents.session === source.session &&
    window.webContents.getURL().includes('#/main/'));
  if (!target) throw new Error('QQ 主窗口尚未就绪，无法打开联系人选择');
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      source.removeListener('destroyed', sourceClosed);
      target.webContents.removeListener('destroyed', targetClosed);
      target.webContents.removeListener('did-start-navigation', targetNavigated);
      pending.delete(requestId);
    };
    const sourceClosed = () => { cleanup(); resolve(); };
    const targetClosed = () => { cleanup(); reject(new Error('QQ 主窗口已经关闭')); };
    // 主窗口刷新会销毁选择器所在的渲染环境，但不会销毁 webContents。
    const targetNavigated = (_event, _url, isInPlace, isMainFrame) => {
      if (!isInPlace && isMainFrame) {
        cleanup();
        reject(new Error('QQ 主窗口已重新加载，请重新选择转发对象'));
      }
    };
    pending.set(requestId, {
      targetId: target.webContents.id,
      finish(error, result) {
        cleanup();
        if (error) reject(new Error(error));
        else resolve(result);
      },
    });
    source.once('destroyed', sourceClosed);
    target.webContents.once('destroyed', targetClosed);
    target.webContents.on('did-start-navigation', targetNavigated);
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    target.webContents.send('record-columns:forward-request', { ...payload, requestId });
  });
});

ipcMain.on('record-columns:forward-complete', (event, requestId, error, result) => {
  const request = pending.get(requestId);
  if (!request || request.targetId !== event.sender.id) return;
  request.finish(error, result);
});

ipcMain.on('record-columns:ready', event => {
  if (!enabledFor(event) || expanded.has(event.sender)) return;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  expanded.add(event.sender);
  if (window.isMaximized()) return;
  const bounds = window.getBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const width = Math.min(Math.max(bounds.width, 1260), area.width);
  const height = Math.min(Math.max(bounds.height, 720), area.height);
  // 展开后保持窗口控件可见，不能让新增列的关闭按钮超出当前显示器的工作区域。
  window.setBounds({
    x: Math.min(Math.max(bounds.x, area.x), area.x + area.width - width),
    y: Math.min(Math.max(bounds.y, area.y), area.y + area.height - height),
    width,
    height,
  });
});
