# GrizzyCode

Electron desktop AI assistant modelled on the feature set of Claude.app (see `docs/RE-FINDINGS.md`).

```bash
npm install                      # if Electron's binary is missing: cd node_modules/electron && node install.js
npm start                        # launch
npx electron scripts/check.js    # headless backend tests (mock API, permission modes, plan flow, git, worktrees, pty, ssh, import, MCP, skills)
npx electron scripts/shot.js out # render the real UI to PNGs (light; add `dark`)
```

1. Settings → Account: **Continue in browser** signs in to OpenRouter (OAuth + PKCE, Claude models included), or open the Anthropic Console, copy a key and GrizzyCode picks it up. Model & API also takes any OpenAI-compatible base URL (presets for Anthropic, OpenRouter, OpenAI, Ollama).
2. **New chat** or **Code** (pick a folder; risky tools ask for approval).
3. Alt+Space opens Quick Entry (paste images, Esc dismisses). Code sessions have permission modes (Ask / Accept edits / Plan / Bypass), a terminal pane (⌃`) and a Changes pane (⇧⌘D). ⌘/ lists all shortcuts; right-click a session for more.
4. MCP servers: Settings → Connectors → Add connector (local command or remote URL, with Test), or Import JSON. Skills: Settings → Skills.

5. **Providers** (Settings → Providers): Anthropic, OpenRouter, OpenAI, Gemini, Groq, Mistral, xAI, DeepSeek, Ollama and LM Studio are built in; add any OpenAI- or Anthropic-compatible endpoint. Each provider has its own base URL, key, model list, and an on/off switch; every provider that is on appears (grouped, collapsible, searchable) in the model picker.
6. **Mods** (Settings → Mods, or `/mods` in a chat): GrizzyCode runs Claude Code mods (function-hook plugins) in worker threads. Mods installed with `claude plugin install` are found automatically; turn each on after reviewing it. Mods are programs with file and process access, so only enable ones you trust. Supported: slash commands, bands above the prompt, side panes, status lines, `$.ask` dialogs, mod tools, message rewrites (e.g. screen-share), prompt/tool/turn hooks, `$.model`, `$.fs`, `$.process`, `$.store`/`$.state`. Not supported: agent spawning, terminal-only surfaces, `$.http`, `$.mcp.connect`, audio.

7. **Grizzy agent** (model picker → Grizzy): runs the real Claude Code CLI through `npx -y @zed-industries/claude-code-acp`. **On a new computer, install the Claude Code CLI first** (`npm i -g @anthropic-ai/claude-code`, then `claude /login`) and make sure Node/npx is available. GrizzyCode shows a reminder in the model picker and in the error message when `claude` isn't found.

8. **Agents that work together** (Settings → Capabilities → Agents): the model can hand a task to any enabled agent (Engineer, Reviewer, your own…) with `delegate_agent`. Each runs as its own conversation with its persona, model and tools, several in one turn run in parallel, and its report comes back as the tool result. `message_agent` sends a follow-up to an agent by id (or relays one agent's findings to another). Agents can delegate one level further; their tool calls use the conversation's permission mode (a delegated agent can only be stricter, never looser) and approval cards name the agent. Delegated agents are saved with the conversation, so you can keep messaging them after a restart.

Settings and data live in `~/.GrizzyCode` (`data/`, `mods/`, `logs/`). On first launch, data from `~/Library/Application Support/GrizzyCode` is copied there.
