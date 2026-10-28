# Reverse-engineering findings: Claude.app → GrizzyCode

Two passes, both **static analysis only** (neither app was run under instrumentation):

| Pass | Target | Depth |
|---|---|---|
| 1 | `/Applications/Claude.app` v2.42304.2 (arm64) | Targeted reading of the main chunk, preloads, CSS and `en-US.json` |
| 2 (latest) | `/Applications/Claude.app` v3.1623.4 (arm64) | Fuses, extracted-asar inventory, bundle keyword survey, `Info.plist`, helpers, locale counts |

Pass 2 did **not** re-read the main-process chunks. Anything under "Pass 1 details" is as observed on 2.42304.2 and not re-verified against 3.1623.4.

## Method and tool limits
- REA `inspect_electron_fuses` worked on both versions (pass 2: Evidence `ev_15ea384915dd…c089`).
- REA `analyze_javascript_application` is unusable on this app: pass 1 got `artifact_integrity_mismatch` on a re-signed native binding, then a timeout on the 49 MB archive and worker heap exhaustion on a 340 KB renderer bundle; pass 2 timed out again on the 50 MB `app.asar` (`integrity_policy: record-and-continue`). A graph from it would be partial, which is a tool limit, not absence of behavior.
- Fallback: `@electron/asar extract` into an isolated directory (about 93 MB, 391 `index.chunk-*.js` plus workers), then file inventory and keyword searches. Keyword counts below show that a subsystem exists, not how it works.
- GrizzyCode's own fuse state and entitlements were not checked.

## Observed on 3.1623.4

**Platform and packaging**

| | Claude.app 3.1623.4 | GrizzyCode 0.1.0 |
|---|---|---|
| Electron / Chromium | 44.9.0 / 152 | 33.4.11 / 130 |
| Bundle ID | `com.anthropic.claudefordesktop` | `com.grizzycode` |
| Min macOS | 13.0 | 11.0 |
| Source size | about 93 MB extracted, 391 chunks | 2,335 lines, 17 files |
| URL schemes | `claude://`, `msauth.com.anthropic.claudefordesktop` | none seen |
| Fuses | RunAsNode, NodeOptions env and Node CLI inspect **off**; cookie encryption, ASAR integrity, OnlyLoadAppFromAsar, file-protocol extra privileges, Wasm trap handlers **on** | not checked |
| Signing | hardened runtime, team Q6L2SF6YDW | hardened runtime, team 5XKHL47YG3 |
| Privacy usage strings | camera, mic, Bluetooth, audio capture, location, local network, Desktop/Documents/Downloads, AppleEvents | generic camera/mic/Bluetooth strings from Electron |

**Architecture**
- Main entry `.vite/build/index.pre.js` (`@ant/desktop`). Windows: main, quick, about, find-in-page, buddy, file viewer, local-exec consent, design, artifact shell, cowork artifact, watch-record chooser, computer-use teach/watch.
- Workers: `pty-host`, `mcp-runtime`, `file-index`, `transcript-search`, `shell-path`, `heavy-work`, `stall-sampler`. Terminal is a real pty (`node-pty`).
- **Correction to pass 1:** the app ships a local frontend, `Resources/ion-dist` (about 211 MB, `frame-shell`/`client-shell` HTML, about 4,179 assets, i18n). Pass 1 recorded the chat UI as remote-only and not recoverable; for this version it is at least partly packaged locally. Whether the main window still loads claude.ai at runtime is **unknown**.
- Helpers: `app-cu-helper` (computer use), `Claude iOS Sim.app` plus `claude-ios-sim.sb` sandbox profile, `chrome-native-host`, `claude-ssh-askpass`, `permission-fixer`, `disclaimer`; native modules `claude-native`, `claude-swift`; a 23 MB VM image `smol-bin.arm64.img`.
- Bundled resources: skills (`docx`, `pdf`, `pdf-reading`, `pptx`, `xlsx`, `frontend-design`), artifact libraries (Chart.js 4.5, Grid.js 5, Mermaid 11), GitHub MCP server binary, Office 365 MCP (MSAL runtime, PDF extractor).
- Subsystem presence (chunks mentioning the term, of 391 plus `index.js`): cowork 76, ssh 81, dispatch 51, worktree 45, scheduled 37, artifact 23, remote control 17, office 16, simulator 13, design 12, computerUse 11, dxt 8, dictation 7, voice 7. `en-US.json`: 861 strings; about 40 locales shipped.

## Pass 1 details (observed on 2.42304.2, not re-verified)

**Quick Entry**
- 606×470 panel (`type:"panel"`), frameless, transparent, shadow, non-resizable/closable, `alwaysOnTop("pop-up-menu")`, hidden in Mission Control, skip taskbar.
- Hides on blur; saves position per display (relative to work area) on hide; default centered on the primary display; restores if still on-screen.
- `requestSkooch(w,h)` keeps a 30 px margin if content would overflow the work area. `requestDismiss(text)`.
- Submits only when text length > 2 or an image is attached. Placeholder: "What can I help you with today?"

**Code sessions / menus / settings**
- Permission modes: `default`, `acceptEdits`, `plan`, `bypassPermissions` (+ `auto`, `dontAsk`). Strings: "Trust {cwd} and start a code session?", "Run coding task in bypass permissions mode?", "Allow for this session".
- Menus and accelerators: New Session ⌘N, New Session in New Window, Open Folder ⇧⌘O, Reopen Closed Session ⇧⌘T, Close Session ⌘W, Go ▸ Back/Forward/Search…/Previous & Next Session, Show/Hide Sidebar, Show/Hide Terminal, Zoom In/Out, Keyboard Shortcuts.
- Session layout schema (popouts, panes, projects, `alwaysOnTop`, `bounds`), pinned Git origins/folders, CLI import from `<configDir>/projects/*/*.jsonl`, usage panel, update checker, system-tray preference.

**Design tokens (CDS)**: warm-gray scale (`#f9f9f7`…`#20201f`…`#0b0b0b`), clay `#d97757` / `#c6613f`, body 13 px, code 12 px, composer radius 0.75–0.875 rem, system sans with a serif "voice" face, git status colors.

## Differences: what Claude has that GrizzyCode lacks
- Cowork (VM-backed agent workspace, live artifacts), computer use, iOS Simulator tool, browser shim and Chrome extension bridge.
- SSH sessions, git worktrees (GrizzyCode only shows `git diff` and a branch chip), remote control.
- Extensions/connectors: DXT registry, bundled GitHub and Office 365 MCP servers.
- Bundled skills and artifact libraries (GrizzyCode's `skills/` is empty).
- Real pty terminal and background workers (GrizzyCode runs everything in the main process; terminal is non-pty).
- Dictation/voice, buddy window, design window, account/plan/usage backend, managed config, SBOM, `claude://` deep links, about 40 locales.

## Differences: what GrizzyCode has that Claude lacks
- Bring-your-own API key with any OpenAI-compatible base URL (Claude uses its own account backend).
- Plain, readable tool set: `read_file`, `list_dir`, `grep`, `write_file`, `edit_file`, `bash`, `exit_plan_mode`, `use_skill`.
- Export Conversation, Open MCP Config, Reload MCP Servers, Open Skills Folder menu items.
- Headless backend tests (`scripts/check.js`) and UI screenshot script (`scripts/shot.js`).
- Local scheduled tasks, dispatched background sessions and artifact extraction (`src/main/features.js`); Claude's equivalents are much broader.

## Not reproduced (unknown / out of scope)
Cowork VM, computer use, Office add-in, DXT registry, simulator/browser tools, buddy window, SSH sessions, account sync, remote control, proprietary Anthropic fonts, the `ion-dist` frontend, claude.ai itself.

## GrizzyCode parity map (vs 2.42304.2 behavior)
| Claude.app | GrizzyCode |
|---|---|
| Quick Entry panel (606×470, blur-hide, skooch, per-display position, >2 chars/images) | Same geometry & behavior, image paste/drop |
| Permission modes + trust prompt + bypass confirm + "allow for session" | Implemented; plan mode offers read tools + `exit_plan_mode` approval that switches to Accept edits |
| Menus/accelerators incl. reopen closed, prev/next session, back/forward, new window | Implemented |
| Sidebar, Terminal and Changes panes, branch chip, zoom, tray, usage | Implemented (terminal is non-pty; changes = `git diff`) |
| Import CLI sessions | Implemented (drops thinking blocks and orphan tool calls) |
| MCP (`mcpServers`), skills (`SKILL.md`/`.skill`) | Implemented |
| Design tokens, light/dark | Matched to observed values (system fonts instead of Anthropic's) |

Parity was not re-checked against 3.1623.4; menus, accelerators and permission strings may have changed.

All code is original; no Anthropic source, assets, fonts, or branding was copied.

## Alignment work done against 3.1623.4 (GrizzyCode 0.1.0, Electron 33 → 44.9.3)
Menus re-read from the 3.1623.4 main chunk (`index.chunk-uXhgx7My.js`): Command Palette ⌘K, Sidebar **⌘B**, Close Pane **⌘\**, Changes ⇧⌘D, Preview ⇧⌘P / Browser ⇧⌘B, Files ⇧⌘F, Side Chat ⌘;, Split View ⌃⌘\ / ⌃⌘- / ⌃] / ⌃[ / ⌃⌘W, Edit ▸ Find ⌘F / ⌘G / ⇧⌘G, Open File ⌘O, Keyboard Shortcuts ⌘/, Dev Tools ⌥⌘I, Reopen Closed Session ⇧⌘T. Permission mode keys (`acceptEdits`, `bypassPermissions`, `dontAsk`, plan) and the "Trust {cwd}" string are unchanged.

| Gap | What GrizzyCode now does |
|---|---|
| Terminal was non-pty | Real pty per session (`node-pty` + xterm.js), resize, TUIs work; unpacked from asar |
| Worktrees | "Worktree" chip on a new code session creates `grizzy/<slug>-<id>` in `<repo-parent>/.grizzycode-worktrees/`; deleting the session removes it only if clean |
| SSH sessions | "SSH" environment dialog (hosts from `~/.ssh/config`); file/shell tools and the terminal run on the remote host via system `ssh` (BatchMode, key/agent auth) |
| Bundled skills | docx, pdf, pptx, xlsx, frontend-design written from scratch (Anthropic's `.skill` files were **not** copied) and seeded once into the user skills folder |
| Artifact libs | Chart.js 4.5, Grid.js 5, Mermaid 11 from npm; previews rewrite CDN URLs to local copies |
| Menus | Sidebar ⌘B, Close Pane ⌘\, Edit ▸ Find (⌘G / ⇧⌘G), Dev Tools ⌥⌘I |
| Platform | Electron 44.9.3 (same as Claude.app 44.9.0 line) |

Still not matched: Split View, Files/Preview/Side Chat panes, Command Palette, Open File, `claude://`-style deep links, usage strings in `Info.plist`, Electron fuses (not checked), workers, Cowork, computer use, simulator, DXT registry. The `ensureSwiftAddon` / "Claude.app parity" handlers in `src/main/main.js` and `src/preload.js` are stubs that return empty values; they do not provide the features their names suggest.

## Sign-in
Claude.app signs in with Anthropic's own claude.ai OAuth client. GrizzyCode does not reuse it (that would impersonate Claude.app), so browser sign-in is: OpenRouter OAuth authorization-code + PKCE S256 through a one-shot `http://localhost:<port>/callback` loopback (state-checked, code exchanged for a per-user key), and for Anthropic, opening the Console keys page and using a key copied to the clipboard (detected on request, masked in the UI, clipboard cleared after saving).

## Settings parity (Claude Desktop 3.1623.4 page list → GrizzyCode)
Page list taken from the desktop app's Settings rail; per-page labels cross-checked against the strings bundled in `ion-dist/i18n/en-US.json` and the native shell strings in `en-US.json`.

| Claude page | GrizzyCode |
|---|---|
| General | Display name, personal preferences (added to every prompt), color mode, font, zoom, desktop notifications + sound |
| Account | Browser sign-in (OpenRouter), key capture (Anthropic), connected providers, sign out |
| Privacy | No-telemetry statement, auto-delete after N days, export, delete conversations / memory / everything |
| Billing | OpenRouter live credit balance, Anthropic billing links, estimated spend |
| Usage | Cards, per-day chart, by model / tab, cache split, ranges |
| Capabilities | Artifacts, memory, skills, shell, file edits, web fetch (SSRF-guarded) — disabled tools are never offered to the model |
| Memory | Memory on/off, auto-save via `save_memory` tool, add / edit / delete / clear |
| Design systems | Named colors, fonts, radius, guidelines; the default one is added to prompts |
| Claude Code | Permission mode, allow bypass, max steps, auto-open files, branch prefix, worktree folder, shell, terminal font, folders, CLI import |
| Claude in Chrome | **Browser tools**: Playwright connector (own browser, not your Chrome profile) — the Chrome extension bridge is not reproducible |
| System | Launch at login, tray, keep awake, quick entry shortcut, hardware acceleration, notifications |
| Extensions | Catalog of one-click MCP connectors, `.mcpb` / `.dxt` install (bundles needing user configuration are declined) |
| Developer | Developer mode, logs, config files, diagnostic report, clear cache, reset app data, about |
| Skills / Connectors | As before |
| Plugins | Folder / `.plugin` / `.zip` bundles of skills, connectors (`.mcp.json`) and slash commands (`commands/*.md`), with a confirmation listing what will run |
| API keys | Default endpoint form, presets, links to provider key pages |

Not matched on purpose: Anthropic account billing (no API), cloud sync, organization policy, Cowork VM, dictation, hardware devices. Launch at login is wired to `app.setLoginItemSettings` but was not toggled in tests so as not to register a login item for the dev build.

## Providers and mods
- **Providers**: a registry of built-in providers (override URL / key / models / on-off) plus custom ones; model strings are `<providerId>:<model>` (bare ids use the legacy default endpoint). Keys are stored under the provider id in the encrypted key store; local providers need none.
- **Mods**: GrizzyCode implements the Claude Code mod engine (`claude-code` module: `register(on, options)`, `$`, `atom/read/update/derive/memberOf`) with one worker thread per mod (`src/main/mods/worker.js`, TS/JSX transpiled with sucrase, `vm` context with no Node). The host (`src/main/mods/host.js`) raises `session.start`, `prompt.submit`, `prompt.compose`, `command.run`, `tool.call`, `turn.start/step/complete`, `ui.render`, `ui.press`, `ui.close` through the mods' hook chains and answers `$.ui/fs/process/session/model/store/state/tool/command/clock/env`. Mod element trees (Box, Text, Button, Svg, Link, Code, Markdown, Input, Select) are drawn in the renderer as the band above the prompt, side panes and message rewrites. The nine "benai" mods load and run unchanged; their `~/.claude/mods/*` state is shared with Claude Code. The vm sandbox keeps mods away from Node/DOM but is not a security boundary: mods run with the user's permissions, which is why each one is switched on explicitly after a warning.


## Artifacts (Claude.app 3.1623.4 → GrizzyCode)
Read from the extracted `app.asar` (`artifactShell.js`, `coworkArtifact.js` and the main chunk `index.chunk-C7NkbHFq.js`); static reading only.

| Claude.app | GrizzyCode |
|---|---|
| Typed artifacts (`design`, `slides`; types gated by settings) with uuid, title, createdAt/updatedAt | Stored in `<data>/artifacts/<uuid>.json`: types `page`, `dashboard`, `slides`, `doc`, `design`, `tracker`, `diagram`; versions (last 25) |
| Own window on a private scheme (`cowork-artifact://`), separate session partition, permission requests/checks denied, all non-scheme requests cancelled, popups denied, navigation locked | `gc-artifact://<uuid>/` on `persist:gc-artifact`: same restrictions, plus a CSP header with `connect-src 'none'`; bundled Chart.js / Mermaid / Grid.js served from `/lib/` |
| Preload exposes `window.cowork`: `callMcpTool`, `askClaude`, `runScheduledTask`; external links go to the host; every IPC call checks the sender frame | `window.cowork`: same three plus `db`, `listMcpTools`, `saveFile`, `openExternal`; the artifact id is taken from the sender frame's host, never from arguments; first use of the model, each MCP tool and each scheduled task asks the user once |
| MCP tool calls restricted to a per-artifact allow-list that the user grows | Same; allow-list stored on the artifact |
| Frame transport proxying `/api/` fetch and WebSocket over a MessagePort | Not reproduced (no claude.ai API); the `db` bridge covers persistence |
| Type catalog and templates come from the service | Eight built-in templates (`artifact-templates.js`): dashboard, slides, doc, design, kanban, diagram, assistant, poll |
