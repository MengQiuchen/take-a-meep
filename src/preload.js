const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('meepDesktop', {
  updateTimerState: (state) => ipcRenderer.send('timer-state', state),
  notifyAlarm: () => ipcRenderer.send('alarm'),
  setLanguage: (lang) => ipcRenderer.send('ui-language', lang),
  startWalk: (options) => ipcRenderer.invoke('start-walk', options || {}),
  cancelWalk: () => ipcRenderer.invoke('cancel-walk'),
  // Mouse dragging: screen coordinates come from the pointer events.
  dragStart: (point) => ipcRenderer.invoke('drag-start', point),
  dragMove: (point) => ipcRenderer.send('drag-move', point),
  dragEnd: (release) => ipcRenderer.invoke('drag-end', release),
  onWalkState: (callback) => subscribe('walk-state', callback),
  onDragState: (callback) => subscribe('drag-state', callback),
  onTrayAction: (callback) => subscribe('tray-action', callback)
});
