/* ─── Canvas colours — SINGLE SOURCE OF TRUTH ──────────────────────────────
   The window's NSWindow backgroundColor and the renderer's --canvas MUST be
   the same colour, in both appearances. When they diverge, macOS shows the
   difference: the system corner mask carves an arc out of the window, and the
   crescent between that arc and the square top edge of the web contents is
   unpainted by the renderer — so it shows NSWindow's own backgroundColor. On
   macOS 27 (Golden Gate) the uniform ~20pt mask makes that crescent large
   enough to read as a coloured wedge. Before this module the window colour was
   hardcoded '#111111' (dark) while light appearance painted '#E3E3E3', so the
   light-mode wedge was near-black on light grey.

   AUTHORITY: styles.css is the design source. These values MUST equal what
   --canvas resolves to for html[data-theme="dark"] and html[data-theme="light"]
   (styles.css:101 and styles.css:119). test/theme_canvas_sync_test.js parses
   styles.css and fails on drift — if the two ever disagree, styles.css wins and
   this module is what changes.

   ONE consumer: main, for window construction and the 'theme:changed' mirror.
   The renderer deliberately does not read these — it already has the colour
   from the stylesheet, and only tells main WHICH theme is painted (a boolean,
   via preload's setTheme). Handing the hex across the bridge as well would
   re-create the second copy this module exists to remove. */
const CANVAS = { dark: '#111111', light: '#E3E3E3' };

/* The one place a boolean becomes a colour. Anything truthy is dark. */
function canvasFor(dark) {
  return dark ? CANVAS.dark : CANVAS.light;
}

module.exports = { CANVAS, canvasFor };
