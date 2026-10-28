<div align="center">

<img src="src/assets/icon-128.png" alt="GrizzyCode" width="112" height="112">

# 🐻 GrizzyCode

**A desktop AI assistant for your Mac: chat, a code agent, MCP tools, skills, mods and quick entry.**

![Platform](https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-44-47848F?logo=electron&logoColor=white)
![Version](https://img.shields.io/badge/version-0.6.0-8A2BE2)
![License](https://img.shields.io/badge/license-MIT-2EA44F)
![MCP](https://img.shields.io/badge/MCP-ready-FF6B35)

[✨ Features](#-features) · [🚀 Quick start](#-quick-start) · [🔌 Providers](#-providers) · [🧩 Mods](#-mods) · [💸 Token savers](#-token-savers) · [🛠️ Development](#️-development)

</div>

---

## ✨ Features

| | Feature | What it does |
|---|---|---|
| 💬 | **Chat** | Conversations with any model from any provider you turn on. |
| 👨‍💻 | **Code sessions** | Pick a folder; the agent reads, searches, edits and runs commands. Risky tools ask first. |
| 🔐 | **Permission modes** | Ask · Accept edits · Plan · Bypass. Plan mode is read-only until you approve the plan. |
| 🔌 | **Providers** | Anthropic, OpenRouter, OpenAI, Gemini, Groq, Mistral, xAI, DeepSeek, Ollama, LM Studio, or any compatible endpoint. |
| 🧰 | **Connectors (MCP)** | Local commands or remote URLs, with a Test button, JSON import and OAuth sign-in. |
| 📧 | **Google apps** | Built-in Gmail, Calendar, Sheets, Docs and Drive tools behind one Google sign-in. |
| 🎓 | **Skills** | Installable instruction folders the model loads when relevant. |
| 🤝 | **Agents** | Hand tasks to Engineer, Reviewer or your own agents. They run in parallel, and you can message them later. |
| 🧩 | **Mods** | Panels, status lines and slash commands around your chats. Create, export and publish your own. |
| 💸 | **Token savers** | Tool router, output compression, history compaction and pinned facts. |
| ⚡ | **Quick Entry** | <kbd>⌥</kbd> <kbd>Space</kbd> anywhere. Paste images, <kbd>Esc</kbd> to dismiss. |
| 🖥️ | **Terminal and diffs** | Built-in terminal pane and a Changes pane for your code sessions. |
| 🧠 | **Memory** | Facts it remembers across conversations. You control them. |
| 📁 | **Projects** | Group chats under shared instructions and an optional default folder. Closed chats stay listed on the project page. |
| 🧪 | **Artifacts** | The model builds dashboards, slide decks, documents, trackers, diagrams and prototypes with its `artifact` tool. Each opens in its own sandboxed window (no network, versioned, exportable) and can use a small `window.cowork` bridge: persistent `db`, `askClaude`, allow-listed MCP tools and scheduled tasks. Eight built-in templates; code blocks from chats are listed too. |
| ⏰ | **Scheduled tasks** | Run a prompt every N minutes, daily or on weekdays. |
| 📨 | **Dispatch** | Start a background code session and check on it later. |
| 🌿 | **Worktrees** | Work on a new git branch in a separate worktree. |
| 🌍 | **SSH sessions** | Run a code session's file and shell tools on a remote host. |
| 🎨 | **Design systems** | Colors, fonts and guidelines the model follows when it builds interfaces. |
| 🌐 | **Browser tools** | Let code sessions drive a real browser through the Playwright connector. |
| 📈 | **Usage and billing** | Token usage across Chat and Code by model (7, 30 or 90 days) and estimated spend on this Mac. No subscription, no fees. |

## 🚀 Quick start

```bash
npm install        # if Electron's binary is missing: cd node_modules/electron && node install.js
npm start          # launch GrizzyCode
```

1. 🔑 **Sign in.** Settings → Account → **Continue in browser** signs in to OpenRouter (OAuth + PKCE, Claude models included). Or open the Anthropic Console, copy a key and GrizzyCode picks it up.
2. 💬 **Start.** Choose **New chat**, or **Code** and pick a folder.
3. ⚡ **Go fast.** <kbd>⌥</kbd> <kbd>Space</kbd> opens Quick Entry, <kbd>⌃</kbd> <kbd>`</kbd> toggles the terminal, <kbd>⇧</kbd> <kbd>⌘</kbd> <kbd>D</kbd> toggles Changes, <kbd>⌘</kbd> <kbd>/</kbd> lists every shortcut. Right-click a session for more.

> [!NOTE]
> **Privacy:** no telemetry, no analytics. Conversations go only to the provider you chose. API keys are encrypted with the system keychain and never included in exports. Settings → Privacy can delete old chats automatically, export your data, or delete it.

> [!NOTE]
> **System:** launch at login, keep running in the menu bar, keep the Mac awake while working, a rebindable Quick Entry shortcut, light and dark themes and font choices.

> [!NOTE]
> Settings and data live in `~/.GrizzyCode` (`data/`, `mods/`, `logs/`). On first launch, data from `~/Library/Application Support/GrizzyCode` is copied there.

## 🔌 Providers

Settings → **Providers**. Each provider has its own base URL, key, model list and on/off switch. Every provider that is on appears in the model picker (grouped, collapsible, searchable).

| Provider | | Provider | |
|---|---|---|---|
| 🅰️ Anthropic | built in | 🧠 DeepSeek | built in |
| 🌐 OpenRouter | built in | ✖️ xAI | built in |
| 🤖 OpenAI | built in | 🌬️ Mistral | built in |
| ✨ Google Gemini | built in | 🦙 Ollama | local, no key |
| ⚡ Groq | built in | 🖥️ LM Studio | local, no key |

Add any OpenAI- or Anthropic-compatible endpoint as a custom provider.

### 🐻 Grizzy agent

Pick **Grizzy** in the model picker to run the real Claude Code CLI through `npx -y @zed-industries/claude-code-acp`.

> [!IMPORTANT]
> On a new computer, install the Claude Code CLI first: `npm i -g @anthropic-ai/claude-code`, then `claude /login`. Make sure Node and `npx` are available. GrizzyCode shows a reminder in the model picker when `claude` isn't found.

## 📁 Projects

A project groups chats under shared instructions.

1. Open **Projects** and click **New project**, then give it a name.
2. Write **instructions** (tone, context, rules). They are added to every chat in the project.
3. Optionally choose a **default folder**. Chats then start as code sessions there.
4. **Save**, then **New chat in project**. The project page lists its chats, closed ones included, and clicking one reopens it.

Deleting a project keeps its chats; they only lose the project instructions.

## 🧰 Connectors, extensions, plugins and skills

- **MCP servers:** Settings → Connectors → **Add custom connector** (local command or remote URL, with Test), or **Import JSON**. Each tool is *Always allow*, *Needs approval* or *Blocked*.
- **Remote connectors sign in with OAuth:** if a server answers 401, choose **Sign in…** — GrizzyCode finds the server's authorization endpoints, registers itself (or uses a client ID you enter), signs you in through your browser with PKCE, keeps the tokens sealed and refreshes them. A header you type yourself always wins.
- **Google (Gmail, Calendar, Sheets, Docs, Drive):** built in under Settings → Connectors → **Google**. Create a Google Cloud OAuth client once, paste its Client ID and secret, and one browser sign-in (PKCE) unlocks all five apps. Credentials and tokens are stored sealed on this computer and tokens refresh on their own. Read tools are marked read-only; sending mail, deleting events and overwriting cells ask first by default, and you can set any tool to *Always allow*, *Needs approval* or *Blocked*.
- **Extensions:** Settings → Extensions has one-click connectors (Filesystem, Knowledge graph memory, Sequential thinking, Browser (Playwright), Fetch, Git, Time) and installs `.mcpb` / `.dxt` bundles.
- **Plugins:** Settings → Plugins installs a folder or `.plugin` / `.zip` that bundles skills, connectors and slash commands.
- **Skills:** Settings → Skills. GrizzyCode ships `docx`, `pdf`, `pptx`, `xlsx`, `frontend-design` and `mod-authoring`.
- **Web access:** Settings → Capabilities → **Fetch web pages** lets the model read public pages and APIs. Local and private addresses are always blocked.

## 👨‍💻 Code sessions

| | | |
|---|---|---|
| 📂 | **Folders** | Each session works in a folder you pick. Trusted folders skip the trust prompt; pinned folders appear in the Code sidebar. Tool approvals still follow the permission mode. |
| 🌿 | **Worktrees** | Branches are named `prefix + task` (Settings → Claude Code) in a worktree folder you choose. |
| 🌍 | **SSH** | Connect to `user@host` or a config alias; file and shell tools run there with your system `ssh`. |
| 📥 | **Import** | Bring in Claude Code CLI session transcripts from `~/.claude/projects` as GrizzyCode code sessions. |
| 🔁 | **Max steps** | A cap on model turns per message stops a runaway loop. |
| ⏰ | **Scheduled** and 📨 **Dispatch** | Unattended runs deny anything the permission mode wouldn't already allow. |

## 🤝 Agents that work together

Settings → Capabilities → **Agents**.

- 📤 `delegate_agent` hands a task to any enabled agent. Each runs as its own conversation with its own persona, model and tools. Several in one turn run in parallel, and the report comes back as the tool result.
- 💌 `message_agent` sends a follow-up to an agent by id, or relays one agent's findings to another.
- 🔒 A delegated agent can only be **stricter** than the conversation's permission mode, never looser, and approval cards name the agent.
- 💾 Delegated agents are saved with the conversation, so you can keep messaging them after a restart.

### Agents are runtime profiles, not prompts

Engineer, Reviewer, Planner, Researcher and Writer (and any agent you make under Settings → Agents) each carry:

- 🧰 **Tools and folders** they may touch, plus their own model and reasoning effort.
- ⏱️ A **step budget** that caps a run, whether the agent was picked or delegated to.
- 🚧 **Rules on tool calls**, e.g. an existing file must be read before it is edited (refused before anything is written or asked).
- ✅ **Completion checks** run against the tool calls GrizzyCode actually saw: an engineer cannot finish after an edit until a check has run and is not failing; a reviewer's `path:line` references must exist; a researcher may only cite URLs it fetched. A failing check sends the agent back to work (at most twice).
- 🧾 A **run record** the harness appends to every delegated report (files changed, commands run and whether they passed), so the delegating agent need not trust the agent's own account.

- 🧠 Optional **memory**: an agent with memory keeps short notes (`agent_note`) per project folder, sees them in the next conversation there, and you can review or delete them in the agent's settings.

Grizzy (the Claude Code CLI) is separate and is not configured here.

## 🧩 Mods

GrizzyCode runs Claude Code **mods** (function-hook plugins), each in its own worker thread. Settings → Mods, or `/mods` in a chat.

| | Action | How |
|---|---|---|
| 🆕 | **Create** | **New mod…** scaffolds a working mod in `~/.GrizzyCode/mods/<name>`. It never touches Claude Code's folders or any marketplace. |
| 📥 | **Install** | **Install from folder or .zip…**, or any mod installed with `claude plugin install` is found automatically. |
| 🔄 | **Reload** | Re-reads the mod's files after you edit them. |
| 📦 | **Export** | **Export .zip** makes a file anyone can install. |
| 🚀 | **Publish** | **Publish…** adds the mod to a marketplace folder you choose and shows the `/plugin marketplace add` lines. |
| 🗑️ | **Delete** | Removes a mod from GrizzyCode's own folder. |

**Supported:** slash commands, bands above the prompt, side panes, status lines, `$.ui.ask` dialogs, mod tools, message rewrites, prompt/tool/turn hooks, `$.model`, `$.fs`, `$.process`, `$.store`, `$.state`.
**Not supported:** agent spawning, terminal-only surfaces, `$.http`, `$.mcp.connect`, audio.

> [!WARNING]
> Mods are programs with file and process access. Turn on only mods you trust. GrizzyCode asks before enabling each one.

On/off switches live in `~/.GrizzyCode/mods/switches.json`, separate from Claude Code's.

## 💸 Token savers

Settings → Capabilities → **Token savers**. Figures are estimates (about 4 characters per token).

| | Saver | Default | What it does |
|---|---|---|---|
| 🧭 | **Connector tool router** | on | With six or more MCP tools, sends a short catalog plus `mcp_tools` and `mcp_invoke` instead of every schema on every request. |
| 🗜️ | **Output compression** | on | Cuts long command, search, web and connector output to the start, the end and any error lines. The full text is saved locally, and the model reads it back with `retrieve_output`. File reads are never compressed. |
| 📚 | **Conversation compaction** | off | Past a context threshold, older turns become a summary. Your latest messages stay as they are. `/compact` does it on demand. |
| 📌 | **Pinned facts** | always | `/pin <fact>`, `/pins`, `/unpin <n>`. Pinned facts are in every system prompt and survive compaction. |
| 📊 | **Savings stats** | always | Running totals in Settings and in `/usage`. |

## ⌨️ Slash commands

| Command | |
|---|---|
| `/plan` `/accept` `/ask` `/bypass` | Switch permission mode |
| `/compact` | Summarize older messages now |
| `/pin` `/pins` `/unpin` | Manage pinned facts |
| `/usage` | Token usage and savings for this session |
| `/export` | Export the chat as Markdown |
| `/terminal` `/changes` | Toggle panes |
| `/clear` | Start a fresh session |
| `/mods` | Open the mods switchboard |

## 🛠️ Development

```bash
npm start                         # launch
npm run check                     # backend tests plus the headless Projects page test
npx electron scripts/check.js     # backend only (mock API, permission modes, plan flow, git, worktrees, pty, ssh, import, MCP, Google connectors, skills, mods, token savers)
npx electron scripts/ui-check.js  # drives the Projects page against a fake bridge
npx electron scripts/shot.js out  # render the real UI to PNGs (add `dark` for dark mode)
npm run dist                      # build the signed DMG and zip into dist/
```

📁 **Layout**

```
src/main/        main process: agent loop, providers, MCP, tools, savings, mods host
src/main/mods/   mod host, worker sandbox, authoring (create/export/publish)
src/renderer/    the UI
skills/          bundled skills
scripts/         tests (check.js, ui-check.js) and screenshots
docs/            reverse-engineering notes (RE-FINDINGS.md)
```

## 📄 License

MIT. See `package.json`.

<div align="center">

Made with 🐻 for people who live in their editor.

</div>


## Coding tools
- **Project instructions:** `GRIZZY.md`, `AGENTS.md` or `CLAUDE.md` (first found per folder) in the working folder and its parents up to the repository root are added to the system prompt of local code sessions (12 KB each, 24 KB total). Turn off with `projectInstructions: false` in settings.
- **Task list:** the model keeps a checklist with `todo_write`; it shows as a progress chip in the status bar.
- **Search and edit:** `glob`; `grep` with `glob`, `ignore_case`, `context`, `output_mode` and `head_limit`; `edit_file` with `replace_all`, atomic multi-`edits`, and a refusal when the file changed since it was last read.
- **Hooks:** Tools ▸ Open Hooks Config edits `tool-hooks.json` in the data folder: `{"hooks":[{"event":"PreToolUse|PostToolUse","matcher":"write_file|edit_file","command":"...","timeout":30}]}`. The command gets the call as JSON on stdin plus `GC_TOOL`, `GC_FILE`, `GC_CWD`. Exit code 2 blocks a Pre hook (stderr goes to the model) or appends stderr to a Post result. Local sessions only.
- **web_search:** keyless DuckDuckGo HTML search, enabled with the web capability. It parses the results page, so it can break if that markup changes.
