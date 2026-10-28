// Preload for artifact windows (scheme gc-artifact://). Exposes the `window.cowork` bridge; the main process re-checks the sender on every call.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'gc-artifact:' && window.top === window) {
  const call = (name, ...a) => ipcRenderer.invoke('cowork:' + name, ...a);
  const str = (v, n) => String(v ?? '').slice(0, n);
  contextBridge.exposeInMainWorld('cowork', {
    askClaude: (prompt, data) => call('askClaude', str(prompt, 30000), data),
    callMcpTool: (tool, args) => call('callMcpTool', str(tool, 300), args),
    listMcpTools: () => call('listMcpTools'),
    runScheduledTask: (id) => call('runScheduledTask', str(id, 100)),
    saveFile: (name, content) => call('saveFile', str(name, 200), str(content, 20 * 1024 * 1024)),
    openExternal: (url) => call('openExternal', str(url, 2000)),
    info: () => call('info'),
    db: {
      get: (c, id) => call('db', 'get', c, id),
      set: (c, id, data) => call('db', 'set', c, id, data),
      update: (c, id, data) => call('db', 'update', c, id, data),
      delete: (c, id) => call('db', 'delete', c, id),
      list: (c) => call('db', 'list', c),
    },
  });
  // Links never navigate the sandbox: http(s)/mailto go to the system browser.
  const open = (e) => {
    if (!e.isTrusted) return;
    const a = e.target?.closest?.('a[href]'); if (!a) return;
    if (/^(https?|mailto):/i.test(a.href)) { e.preventDefault(); call('openExternal', a.href); }
    else if (!a.getAttribute('href').startsWith('#')) e.preventDefault();
  };
  window.addEventListener('click', (e) => { if (e.button === 0) open(e); }, true);
  window.addEventListener('auxclick', (e) => { if (e.button === 1) open(e); }, true);
}
