---
name: mod-authoring
description: Create, edit or publish a GrizzyCode mod (panels, status text, slash commands, hooks around chats). Use when the user asks to make or change a mod.
---
# Making a GrizzyCode mod

**Where it goes.** Create every new mod in `~/.GrizzyCode/mods/<name>/`. Never write into `~/.claude/plugins`, a marketplace folder (such as `benai-mods`) or another mod's folder, and never edit a mod that came from Claude Code in place. Names are lowercase letters, digits and single dashes (`my-mod`) and must not match an existing mod.

**Layout** (the same format Claude Code uses):

```
<name>/.claude-plugin/plugin.json   {"name": "<name>", "version": "0.1.0", "description": "..."}
<name>/hooks/hooks.json             {"modules": ["./register.tsx"]}
<name>/hooks/register.tsx           export const register = (on) => { ... }
```

Easiest start: the user presses **Settings → Mods → New mod…**, which scaffolds all three files. Then edit `hooks/register.tsx`.

**Hooks.** `on('<event>', [matcher], async ($, e, next) => result)`. Events: `session.start`, `prompt.submit`, `prompt.compose`, `command.run`, `tool.call`, `turn.start`, `turn.step`, `turn.complete`, `ui.render`, `ui.press`, `ui.close`. Call `await next(e)` to continue the chain, or return a value to answer. Register a slash command in `session.start` with `$.command.register({ name, description })` and answer it with `on('command.run', { command: name }, ...)` returning `{ text }`. Draw UI in `ui.render` with `{ Box, Text, Button, Input, Select, Link, Code, Markdown } = $.ui.resolve(e)` (`AbovePrompt` is the band above the prompt; `Pane` is a side pane opened with `$.ui.open({ id, title })`).

**The `$` object.** `$.ui` (toast, status, ask, notify, open, close), `$.session` (id, cwd, messages, turns, model, usage), `$.model` (complete, fork, classify), `$.fs` (read, write, list, exists, stat), `$.process.run([argv])`, `$.store` (get, set, delete, keys; per mod), `$.state` / `atom`, `read`, `update` from `'claude-code'`, `$.clock` (after, every, sleep), `$.command`, `$.tool.register` (tools appear as `mcp__<mod>__<tool>`), `$.mcp.call`.

**Limits.** The code runs in a sandbox: no Node, no `process`, no `require`, no `eval`, and no package imports (only relative files and `'claude-code'`). TypeScript and JSX are fine. A hook that runs longer than 15 s is skipped.

**After writing.** Tell the user to open **Settings → Mods**, press **Reload** (or turn the mod on; they confirm a warning). A mod that fails to load shows its error on its card.

**Sharing.** **Export .zip** makes a file anyone can install with *Install from folder or .zip…*. **Publish…** copies the mod into a marketplace folder the user chooses and adds it to `.claude-plugin/marketplace.json`; the result shows the two Claude Code lines to install it (`/plugin marketplace add <folder>`, `/plugin install <name>@<marketplace>`). Only publish when the user asks, and into the folder they name.
