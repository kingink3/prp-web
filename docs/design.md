# Design: mirror the desktop Console

The owner's desktop Console is the visual reference. `docs/console-reference.css` is its stylesheet
(reference only, not loaded). The web client must look like it, adapted for touch.

## Tokens
Use the Console's CSS variables verbatim (`--bg`, `--panel`, `--card`, `--card2`, `--line`, `--line2`, `--fg`,
`--muted`, `--accent`, `--accent-bg`, `--warn`, `--ok`, `--bad`, `--primary`, badge colours, `--r: 12px`,
`--font`), light and dark sets (dark via `prefers-color-scheme` and the manual toggle).

## Header and tabs
- Sticky header, blurred background, bottom border; logo square with the blue→violet gradient + «PRP».
- Tabs = segmented control: container `--card2`, padding 3px, radius 10px; tab buttons without borders,
  muted text, radius 8px; active tab `--panel` background + `--fg` + shadow (same as `nav button.on`).
- Phone (< 700 px): the same segmented control in ONE row, horizontally scrollable without a visible
  scrollbar, active tab scrolled into view; or a bottom tab bar with the same look. Never wraps.
- Sub-tabs (directions, morning steps): pills — 1px `--line` border, radius 999px; active `--accent-bg`
  with `--accent` border and 600 weight.

## Components
- Buttons: `.btn` (panel bg, 1px `--line2`, radius 9px, 7px 13px), `.btn.primary`, `.btn.small` (3px 9px, 12px).
  Touch: min-height 40px on phones.
- Rows (plan items, to-dos): `.row` — panel, 1px line, 4px left border in the kind colour, radius 12px,
  shadow; important `.row.imp` red left border + tinted bg; done → muted + line-through.
- Checkbox `.chk` 20px rounded square; on → `--ok`.
- Section headings `h2`: 12px, uppercase, letter-spacing .9px, muted.
- Cards/columns, badges, calendar cells (`.cal-d` lvl1–3), progress bars (`.pbar`, `.bbar`), toasts — as in the reference.
