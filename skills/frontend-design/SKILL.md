---
name: frontend-design
description: Design and build polished web pages, components and artifacts (HTML/CSS/JS). Use when the user wants a UI that looks intentional rather than generic.
---
# Frontend design

1. **Decide the point of view first**: audience, tone, one memorable idea. State it in a sentence before coding.
2. **Type**: pick a pairing (a distinctive display face plus a quiet text face), a clear scale (e.g. 12/14/16/20/28/44), 1.5 body line height, max line length ~70 characters.
3. **Color**: define CSS variables for background, surface, text, muted, accent, line. One accent. Check contrast (4.5:1 body). Support `prefers-color-scheme`.
4. **Layout**: a consistent spacing scale (4/8/12/16/24/40), generous whitespace, a real grid; mobile first, then widen. Avoid default card-in-card stacking and gratuitous gradients/shadows.
5. **Motion**: short (120–200 ms) eases on state changes only; respect `prefers-reduced-motion`.
6. **Deliver** a single self-contained `.html` (inline CSS/JS) unless asked otherwise. Charts: Chart.js; diagrams: Mermaid; tables: Grid.js. GrizzyCode's artifact preview serves these locally, so referencing the usual CDN filenames works offline.

Test at 375 px and 1280 px widths, with keyboard only, before calling it done.
