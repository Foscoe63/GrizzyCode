// Built-in color themes and accent colors. The renderer applies a theme by setting these CSS variables on <html>;
// "default" has no variables and keeps styles.css as is (it follows the light/dark color mode).
const hex = (h) => { h = h.replace('#', ''); if (h.length === 3) h = [...h].map((c) => c + c).join(''); return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const toHex = (c) => '#' + c.map((n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => { const x = hex(a), y = hex(b); return toHex(x.map((v, i) => v + (y[i] - v) * t)); };
const lum = (h) => { const [r, g, b] = hex(h).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const rgba = (h, a) => `rgba(${hex(h).join(',')},${a})`;
const onColor = (h) => (lum(h) > 0.4 ? '#1a1a19' : '#ffffff');

// id, name, mode, bg, raised, side, text, text2, text3, line, accent, code, codeFg, add, del, mod
const RAW = [
  ['github-light', 'GitHub Light', 'light', '#ffffff', '#f6f8fa', '#f6f8fa', '#1f2328', '#59636e', '#818b98', '#d1d9e0', '#0969da', '#24292f', '#e6edf3', '#1a7f37', '#cf222e', '#9a6700'],
  ['solarized-light', 'Solarized Light', 'light', '#fdf6e3', '#fffdf5', '#eee8d5', '#586e75', '#657b83', '#93a1a1', '#e0d9c3', '#268bd2', '#002b36', '#93a1a1', '#859900', '#dc322f', '#b58900'],
  ['catppuccin-latte', 'Catppuccin Latte', 'light', '#eff1f5', '#ffffff', '#e6e9ef', '#4c4f69', '#6c6f85', '#8c8fa1', '#ccd0da', '#8839ef', '#1e1e2e', '#cdd6f4', '#40a02b', '#d20f39', '#df8e1d'],
  ['gruvbox-light', 'Gruvbox Light', 'light', '#fbf1c7', '#f9f5d7', '#ebdbb2', '#3c3836', '#665c54', '#928374', '#d5c4a1', '#d65d0e', '#282828', '#ebdbb2', '#79740e', '#9d0006', '#b57614'],
  ['rose-pine-dawn', 'Rosé Pine Dawn', 'light', '#faf4ed', '#fffaf3', '#f2e9e1', '#575279', '#797593', '#9893a5', '#dfdad9', '#d7827e', '#26233a', '#e0def4', '#286983', '#b4637a', '#ea9d34'],
  ['paper', 'Paper', 'light', '#f4ecd8', '#fbf5e6', '#ebe1c8', '#433422', '#6b5a43', '#8f7f66', '#dccfb0', '#b5532a', '#2b2418', '#f0e6cf', '#4d7c2f', '#a8322d', '#8a6d1a'],
  ['github-dark', 'GitHub Dark', 'dark', '#0d1117', '#161b22', '#010409', '#e6edf3', '#9198a1', '#6e7681', '#30363d', '#2f81f7', '#010409', '#e6edf3', '#3fb950', '#f85149', '#d29922'],
  ['solarized-dark', 'Solarized Dark', 'dark', '#002b36', '#073642', '#00212b', '#9fb0b0', '#839496', '#586e75', '#0f4553', '#2aa198', '#001f27', '#93a1a1', '#859900', '#dc322f', '#b58900'],
  ['nord', 'Nord', 'dark', '#2e3440', '#3b4252', '#272c36', '#eceff4', '#aab3c5', '#7b88a1', '#434c5e', '#88c0d0', '#242933', '#d8dee9', '#a3be8c', '#bf616a', '#ebcb8b'],
  ['dracula', 'Dracula', 'dark', '#282a36', '#343746', '#21222c', '#f8f8f2', '#b6b8c8', '#6272a4', '#44475a', '#bd93f9', '#1e1f29', '#f8f8f2', '#50fa7b', '#ff5555', '#f1fa8c'],
  ['gruvbox-dark', 'Gruvbox Dark', 'dark', '#282828', '#3c3836', '#1d2021', '#ebdbb2', '#bdae93', '#928374', '#504945', '#fe8019', '#1d2021', '#ebdbb2', '#b8bb26', '#fb4934', '#fabd2f'],
  ['tokyo-night', 'Tokyo Night', 'dark', '#1a1b26', '#24283b', '#16161e', '#c0caf5', '#9aa5ce', '#565f89', '#2f3549', '#7aa2f7', '#16161e', '#c0caf5', '#9ece6a', '#f7768e', '#e0af68'],
  ['catppuccin-mocha', 'Catppuccin Mocha', 'dark', '#1e1e2e', '#313244', '#181825', '#cdd6f4', '#a6adc8', '#7f849c', '#45475a', '#cba6f7', '#11111b', '#cdd6f4', '#a6e3a1', '#f38ba8', '#f9e2af'],
  ['one-dark', 'One Dark', 'dark', '#282c34', '#2c313a', '#21252b', '#abb2bf', '#9da5b4', '#636d83', '#3e4451', '#61afef', '#1e2127', '#abb2bf', '#98c379', '#e06c75', '#e5c07b'],
  ['monokai', 'Monokai', 'dark', '#272822', '#34352e', '#1e1f1c', '#f8f8f2', '#c5c5bb', '#75715e', '#49483e', '#a6e22e', '#1b1c18', '#f8f8f2', '#a6e22e', '#f92672', '#e6db74'],
  ['rose-pine', 'Rosé Pine', 'dark', '#191724', '#26233a', '#14121f', '#e0def4', '#908caa', '#6e6a86', '#2a2740', '#eb6f92', '#12101b', '#e0def4', '#9ccfd8', '#eb6f92', '#f6c177'],
  ['forest', 'Forest', 'dark', '#1b241f', '#243029', '#151c18', '#dbe7de', '#9db3a3', '#6e8576', '#2f3d35', '#7fb685', '#111712', '#dbe7de', '#7fb685', '#e07a7a', '#d4b86a'],
  ['ocean', 'Ocean', 'dark', '#0f1b2a', '#172638', '#0a131e', '#d6e4f5', '#9bb0c8', '#64798f', '#223449', '#38bdf8', '#08111b', '#d6e4f5', '#4ade80', '#fb7185', '#fbbf24'],
  ['midnight', 'Midnight (OLED)', 'dark', '#000000', '#111111', '#000000', '#e8e8e8', '#a0a0a0', '#6b6b6b', '#232323', '#d97757', '#0a0a0a', '#e8e8e8', '#4fd27a', '#ff6b8f', '#d6b84a'],
];

function build(r) {
  const [id, name, mode, bg, raised, side, text, t2, t3, line, accent, code, codeFg, add, del, mod] = r;
  const dark = mode === 'dark';
  return {
    id, name, mode, accent, dark,
    vars: {
      '--bg': bg, '--bg-raised': raised, '--bg-side': side, '--text': text, '--text-2': t2, '--text-3': t3,
      '--line': line, '--line-strong': mix(line, text, 0.28),
      '--hover': rgba(text, dark ? 0.07 : 0.06), '--active': rgba(text, dark ? 0.12 : 0.1),
      '--user': dark ? raised : mix(bg, side, 0.6), '--code': code, '--code-fg': codeFg,
      '--git-add': add, '--git-del': del, '--git-mod': mod, '--danger': del,
      '--shadow': dark ? '0 1px 2px rgba(0,0,0,.3),0 6px 20px rgba(0,0,0,.35)' : '0 1px 2px rgba(0,0,0,.05),0 4px 16px rgba(0,0,0,.06)',
    },
  };
}

const DEFAULT = { id: 'default', name: 'Default', mode: null, accent: '#d97757', dark: false, vars: {} };
const THEMES = [DEFAULT, ...RAW.map(build)];
const ACCENTS = [
  ['clay', 'Clay', '#d97757'], ['red', 'Red', '#ef4444'], ['orange', 'Orange', '#f97316'], ['amber', 'Amber', '#f59e0b'], ['green', 'Green', '#22c55e'],
  ['teal', 'Teal', '#14b8a6'], ['blue', 'Blue', '#3b82f6'], ['indigo', 'Indigo', '#6366f1'], ['purple', 'Purple', '#a855f7'], ['pink', 'Pink', '#ec4899'], ['graphite', 'Graphite', '#6b7280'],
].map(([id, name, color]) => ({ id, name, color }));

const HEXC = /^#[0-9a-f]{6}$/i;
const isTheme = (id) => THEMES.some((t) => t.id === id);
// 'theme' = the theme's own accent, a preset id, or a custom #rrggbb.
const isAccent = (a) => a === 'theme' || ACCENTS.some((x) => x.id === a) || HEXC.test(String(a));
const accentColor = (a) => ACCENTS.find((x) => x.id === a)?.color || (HEXC.test(String(a)) ? String(a).toLowerCase() : null);
// Accent variables derived from one color.
const accentVars = (c) => ({ '--clay': c, '--clay-em': mix(c, '#000000', 0.16), '--on-brand': onColor(c) });
// The color mode the window should use for native controls: a fixed-mode theme wins over the Light/Dark/System choice.
const nativeSource = (settings) => THEMES.find((t) => t.id === settings.colorTheme)?.mode || settings.theme || 'system';

module.exports = { THEMES, ACCENTS, isTheme, isAccent, accentColor, accentVars, nativeSource };
