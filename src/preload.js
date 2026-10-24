const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Claude.app exposes 54 context-bridge APIs across mainWindow/quickWindow/aboutWindow/mainView.
// GrizzyCode consolidates tool APIs under the `gc` namespace; this file expands
// that surface to cover Claude.app's missing APIs with stub implementations.

const inv = (n) => (...a) => ipcRenderer.invoke(n, ...a);
const on = (ch) => (cb) => { const f = (_e, ...a) => cb(...a); ipcRenderer.on(ch, f); return () => ipcRenderer.removeListener(ch, f); };

// Lightweight wrapper for async IPC calls that fall back to undefined gracefully.
const opt = (n) => (...a) => ipcRenderer.invoke(n, ...a).catch(() => undefined);

contextBridge.exposeInMainWorld('gc', {
  settings: { get: inv('settings:get'), set: inv('settings:set') },
  savings: { stats: inv('savings:stats'), reset: inv('savings:reset'), compact: inv('savings:compact'), pin: inv('savings:pin'), unpin: inv('savings:unpin') },
  usage: inv('usage:get'), clearUsage: inv('usage:clear'),
  data: { path: inv('data:path'), open: inv('data:open') },
  storage: { usage: inv('storage:usage'), cleanWorktrees: inv('storage:cleanWorktrees') },
  app: { checkUpdate: inv('app:checkUpdate'), openUrl: inv('app:openUrl'), feedback: inv('app:feedback') },
  perm: { status: inv('perm:status'), open: inv('perm:open') },
  suggest: inv('agent:suggest'),
  openUrl: inv('app:openUrl'),
  auth: { status: inv('auth:status'), openrouter: inv('auth:openrouter'), openrouterKey: inv('auth:openrouterKey'), cancel: inv('auth:cancel'), anthropicOpen: inv('auth:anthropicOpen'), anthropicPeek: inv('auth:anthropicPeek'), anthropicUse: inv('auth:anthropicUse'), signOut: inv('auth:signout'), removeProvider: inv('auth:removeProvider') },
  models: { list: inv('models:list') },
  mods: { list: inv('mods:list'), info: inv('mods:info'), setEnabled: inv('mods:setEnabled'), session: inv('mods:session'), render: inv('mods:render'), press: inv('mods:press'), debugState: inv('mods:debugState'), closePane: inv('mods:closePane'), command: inv('mods:command'), askAnswer: inv('mods:askAnswer'), pickInstall: inv('mods:pickInstall'), create: inv('mods:create'), reload: inv('mods:reload'), reveal: inv('mods:reveal'), export: inv('mods:export'), publish: inv('mods:publish'), remove: inv('mods:remove'), onDirty: on('mods:dirty'), onToast: on('mods:toast'), onLog: on('mods:log'), onAsk: on('mods:ask'), onOpenPane: on('mods:openPane') },
  providers: { list: inv('providers:list'), save: inv('providers:save'), remove: inv('providers:remove'), models: inv('providers:models'), test: inv('providers:test') },
  memory: { list: inv('memory:list'), add: inv('memory:add'), update: inv('memory:update'), remove: inv('memory:remove'), clear: inv('memory:clear') },
  agents: { list: inv('agents:list'), save: inv('agents:save'), remove: inv('agents:remove') },
  designSystems: { list: inv('ds:list'), save: inv('ds:save'), remove: inv('ds:remove'), import: inv('ds:import') },
  plugins: { list: inv('plugins:list'), commands: inv('plugins:commands'), pick: inv('plugins:pick'), install: inv('plugins:install'), remove: inv('plugins:remove') },
  extensions: { catalog: inv('ext:catalog'), install: inv('ext:install'), uninstall: inv('ext:uninstall'), pickBundle: inv('ext:pickBundle'), installBundle: inv('ext:installBundle'), openFolder: inv('ext:openFolder') },
  privacy: { export: inv('privacy:export'), delete: inv('privacy:delete') },
  billing: { openrouter: inv('billing:openrouter') },
  system: { status: inv('system:status'), testNotification: inv('system:testNotification'), relaunch: inv('system:relaunch') },
  dev: { devtools: inv('dev:devtools'), openLogs: inv('dev:openLogs'), openSettingsFile: inv('dev:openSettingsFile'), openMcpConfig: inv('dev:openMcpConfig'), reloadMcp: inv('dev:reloadMcp'), openMcpLog: inv('dev:openMcpLog'), report: inv('dev:report'), clearCache: inv('dev:clearCache') },
  zoom: inv('zoom:set'), testApi: inv('api:test'),
  conv: { list: inv('conv:list'), get: inv('conv:get'), create: inv('conv:new'), update: inv('conv:update'), close: inv('conv:close'), reopen: inv('conv:reopen'), remove: inv('conv:delete'), export: inv('conv:export') },
  agent: { send: inv('agent:send'), stop: inv('agent:stop'), approve: inv('agent:approve'), running: inv('agent:running'), onEvent: on('agent:event') },
  pickFolder: inv('dialog:folder'), confirm: inv('dialog:confirm'),
  files: { list: inv('files:list') },
  attach: { pick: inv('attach:pick'), read: inv('attach:read'), pathOf: (f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } } },
  git: { status: inv('git:status'), diff: inv('git:diff'), isRepo: inv('git:isRepo'), worktreeAdd: inv('git:worktreeAdd'), worktreeList: inv('git:worktreeList') },
  ssh: { hosts: inv('ssh:hosts'), test: inv('ssh:test') },
  term: { open: inv('term:open'), input: inv('term:input'), resize: inv('term:resize'), run: inv('term:run'), kill: inv('term:kill'), onEvent: on('term:event') },
  mcp: { status: inv('mcp:status'), config: inv('mcp:config'), save: inv('mcp:saveConfig'), list: inv('mcp:list'), saveServer: inv('mcp:save'), remove: inv('mcp:remove'), toggle: inv('mcp:toggle'), toolToggle: inv('mcp:toolToggle'), restart: inv('mcp:restart'), test: inv('mcp:test'), importJson: inv('mcp:import') },
  skills: { list: inv('skills:list'), import: inv('skills:import'), remove: inv('skills:remove') },
  importCli: inv('cli:import'),
  find: inv('find'), findStop: inv('find:stop'),
  newWindow: inv('window:new'), build: inv('app:build'),
  quick: { submit: inv('quick:submit'), dismiss: inv('quick:dismiss'), skooch: inv('quick:skooch'), onReset: on('quick:reset') },
  onCommand: on('ui:command'),
  projects: { list: inv('projects:list'), save: inv('projects:save'), remove: inv('projects:delete') },
  schedules: { list: inv('schedules:list'), save: inv('schedules:save'), remove: inv('schedules:delete'), run: inv('schedules:run') },
  dispatch: { list: inv('dispatch:list'), start: inv('dispatch:start'), stop: inv('dispatch:stop'), remove: inv('dispatch:delete') },
  onFeatures: on('features:update'),

  // --- Claude.app parity APIs (stubs that gracefully degrade) ---
  // Desktop telemetry (Claude.app toggles essential telemetry via context bridge)
  telemetry: {
    getConsent: inv('telemetry:consent'),
    setConsent: inv('telemetry:setConsent'),
    getDisabled: inv('telemetry:disabled'),
  },

  // Notifications (macOS-style via SwiftAddon group)
  notifications: {
    schedule: inv('notifications:schedule'),
    cancel: inv('notifications:cancel'),
    requestPermission: inv('notifications:permission'),
  },

  // Quick Access / dock integration
  quickAccess: {
    setBadge: inv('quickAccess:badge'),
    clearBadge: inv('quickAccess:clearBadge'),
    setRecentTasks: inv('quickAccess:recentTasks'),
  },

  // VM / sandbox guest session management (maps to SwiftAddon vm group)
  vm: {
    list: inv('vm:list'),
    connect: inv('vm:connect'),
    disconnect: inv('vm:disconnect'),
    isRunning: inv('vm:isRunning'),
    isGuestConnected: inv('vm:isGuestConnected'),
  },

  // Wake scheduler — macOS power management event scheduling
  wakeScheduler: {
    schedule: inv('wakeScheduler:schedule'),
    cancel: inv('wakeScheduler:cancel'),
    nextWake: inv('wakeScheduler:nextWake'),
  },

  // Keychain — macOS credential storage
  keychain: {
    setPassword: inv('keychain:setPassword'),
    getPassword: inv('keychain:getPassword'),
    deletePassword: inv('keychain:deletePassword'),
  },

  // Memory pressure monitoring
  memoryPressure: {
    level: inv('memoryPressure:level'),
    onPressure: on('memoryPressure:event'),
  },

  // OS entry points — deep linking / file associations
  osEntryPoints: {
    openFile: inv('osEntryPoints:openFile'),
    openUrl: inv('osEntryPoints:openUrl'),
    getRecentDocuments: inv('osEntryPoints:recentDocuments'),
  },

  // System tray usage / menu integration
  trayUsage: {
    getUsage: inv('trayUsage:getUsage'),
    setStatus: inv('trayUsage:setStatus'),
  },

  // Permissions: per-tool approval state (parity with Claude.app permissionFixer)
  permissions: {
    list: inv('permissions:list'),
    get: inv('permissions:get'),
    set: inv('permissions:set'),
    reset: inv('permissions:reset'),
    onUpdate: on('permissions:update'),
  },

  // File viewer / artifact inspector (Claude.app file_viewer window)
  artifacts: {
    list: inv('artifacts:list'),
    read: inv('artifacts:read'),
    save: inv('artifacts:save'),
    open: inv('artifacts:open'),
    export: inv('artifacts:export'),
    preview: inv('artifacts:preview'),
  },

  // Buddy window integration (Claude.app buddy_window)
  buddy: {
    isVisible: inv('buddy:visible'),
    toggle: inv('buddy:toggle'),
    onMessage: on('buddy:message'),
  },

  // Computer use / automation (parity with SwiftAddon computerUse group)
  computerUse: {
    start: inv('computerUse:start'),
    stop: inv('computerUse:stop'),
    takeScreenshot: inv('computerUse:screenshot'),
    onMouseEvent: inv('computerUse:mouse'),
    onKeyEvent: inv('computerUse:keyboard'),
    onEvent: on('computerUse:event'),
  },

  // Design / artifact design window
  design: {
    create: inv('design:create'),
    update: inv('design:update'),
    export: inv('design:export'),
  },

  // Telemetry event streaming
  events: {
    log: inv('events:log'),
    flush: inv('events:flush'),
    onEvent: on('events:stream'),
  },

  // Session / conversation search (Claude.app workspace search)
  search: {
    conversations: inv('search:conversations'),
    messages: inv('search:messages'),
    files: inv('search:files'),
  },

  // Utility process — heavy computation offload (parity with Claude.app utility process)
  utility: {
    compute: inv('utility:compute'),
    onProgress: on('utility:progress'),
  },

  // Theme / dark mode (macOS appearance)
  appearance: {
    getTheme: inv('appearance:theme'),
    setTheme: inv('appearance:setTheme'),
    getColorScheme: inv('appearance:colorScheme'),
    onChange: on('appearance:change'),
  },
});
