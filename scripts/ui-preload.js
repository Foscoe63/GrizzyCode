// Test-only preload for scripts/ui-check.js: replaces the real `gc` bridge with an in-memory fake (no isolation, so a Proxy can be used).
const log = []; const db = { projects: [], convs: [] }; let n = 0;
const settings = { trustedFolders: [], theme: 'system', permissionMode: 'default', activeAgent: '' };
const auto = (path) => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : auto(path + '.' + k)),
  apply: () => Promise.resolve([]),
});
const over = {
  'settings.get': async () => settings, 'settings.set': async (p) => Object.assign(settings, p),
  'projects.list': async () => db.projects.map((p) => ({ ...p, chats: db.convs.filter((c) => c.projectId === p.id).length })),
  'projects.save': async (p) => { const r = { ...p, id: p.id || 'p' + ++n, name: p.name || 'Untitled project', updatedAt: 1 }; const i = db.projects.findIndex((x) => x.id === r.id); if (i >= 0) db.projects[i] = r; else db.projects.push(r); return r; },
  'projects.remove': async (id) => { db.projects = db.projects.filter((p) => p.id !== id); db.convs.forEach((c) => { if (c.projectId === id) c.projectId = null; }); },
  'projects.chats': async (id) => db.convs.filter((c) => c.projectId === id),
  'conv.list': async () => db.convs.filter((c) => !c.archived),
  'conv.create': async (o) => { const c = { id: 'c' + ++n, title: 'New conversation', updatedAt: 1, messages: [], ...o }; db.convs.push(c); log.push(['create', o]); return c; },
  'conv.get': async (id) => ({ ...db.convs.find((c) => c.id === id), messages: [] }),
  'conv.update': async (id, patch) => { Object.assign(db.convs.find((c) => c.id === id), patch); log.push(['update', id, patch]); },
  confirm: async () => true, pickFolder: async () => '/tmp/picked',
};
const walk = (path) => new Proxy(function () {}, {
  get: (_t, k) => (k === 'then' || typeof k === 'symbol' ? undefined : walk(path ? path + '.' + k : k)),
  apply: (_t, _this, a) => (over[path] ? over[path](...a) : Promise.resolve([])),
});
window.gc = walk('');
window.__ui = { log, db };
