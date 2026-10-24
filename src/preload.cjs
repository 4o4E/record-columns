'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// QQ 会在同一窗口重复安装预加载脚本；接口只在该窗口首次创建时注册。
if (!contextBridge.executeInMainWorld({ func: () => Object.hasOwn(window, 'recordColumns') })) {
  contextBridge.exposeInMainWorld('recordColumns', {
    getEnabled: () => ipcRenderer.invoke('record-columns:get-enabled'),
    setEnabled: enabled => ipcRenderer.invoke('record-columns:set-enabled', enabled),
    onEnabledChanged: callback => {
      const listener = (_event, enabled) => callback(enabled);
      ipcRenderer.on('record-columns:enabled', listener);
      return () => ipcRenderer.removeListener('record-columns:enabled', listener);
    },
    ready: () => ipcRenderer.send('record-columns:ready'),
    forward: request => ipcRenderer.invoke('record-columns:forward', request),
    onForwardRequest: callback => {
      const listener = (_event, request) => callback(request);
      ipcRenderer.on('record-columns:forward-request', listener);
      return () => ipcRenderer.removeListener('record-columns:forward-request', listener);
    },
    completeForward: (requestId, error) =>
      ipcRenderer.send('record-columns:forward-complete', requestId, error),
  });
}
