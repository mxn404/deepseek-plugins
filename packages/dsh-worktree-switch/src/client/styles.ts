/**
 * The plugin's own stylesheet, injected once per page.
 *
 * Surfaces already own typography and colour; this sheet only lays out the
 * switch and the panel and borrows `currentColor` for every line, so it stays
 * legible in both themes without owning a palette.
 * @module dsh-worktree-switch/client/styles
 */

/** Marker attribute identifying this plugin's style element. */
const STYLE_ATTRIBUTE = 'data-dsh-worktree-switch-style'

/** The whole sheet. */
const CSS = `
.dsh-wt-chip { display: inline-flex; align-items: center; gap: 6px; }
.dsh-wt-anchor { display: inline-flex; }
.dsh-wt-switch {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 8px; border-radius: 999px;
  border: 1px solid color-mix(in oklab, currentColor 24%, transparent);
  background: transparent; color: inherit; font: inherit; font-size: 12px;
  line-height: 20px; cursor: pointer; white-space: nowrap;
}
.dsh-wt-switch:hover:not(:disabled) { border-color: color-mix(in oklab, currentColor 44%, transparent); }
.dsh-wt-switch:disabled { cursor: default; opacity: .72; }
.dsh-wt-switch[data-phase="failed"] { border-color: color-mix(in oklab, #e5534b 55%, transparent); }
.dsh-wt-switch:focus-visible { outline: 2px solid color-mix(in oklab, currentColor 45%, transparent); outline-offset: 1px; }
.dsh-wt-dot {
  width: 6px; height: 6px; border-radius: 999px;
  background: color-mix(in oklab, currentColor 40%, transparent);
}
.dsh-wt-chip[data-intent="on"] .dsh-wt-dot { background: #2da44e; }
.dsh-wt-chip[data-phase="failed"] .dsh-wt-dot { background: #e5534b; }
.dsh-wt-chip[data-phase="creating"] .dsh-wt-dot { background: #bf8700; }
.dsh-wt-label { max-width: 240px; overflow: hidden; text-overflow: ellipsis; }
.dsh-wt-retry {
  border: none; background: transparent; color: inherit; font: inherit; font-size: 12px;
  text-decoration: underline; cursor: pointer; padding: 0 2px;
}
.dsh-wt-panel {
  display: flex; flex-direction: column; gap: 16px; padding: 20px 28px 40px;
  color: inherit; font: inherit; overflow: auto; height: 100%;
}
.dsh-wt-panel-head { display: flex; align-items: center; gap: 14px; }
.dsh-wt-titles { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.dsh-wt-titles h2 { margin: 0; font-size: 16px; font-weight: 600; }
.dsh-wt-titles p { margin: 0; font-size: 12px; opacity: .72; }
.dsh-wt-back, .dsh-wt-refresh, .dsh-wt-discard {
  border: 1px solid color-mix(in oklab, currentColor 24%, transparent);
  background: transparent; color: inherit; font: inherit; font-size: 12px;
  border-radius: 6px; padding: 6px 12px; cursor: pointer;
}
.dsh-wt-back:hover, .dsh-wt-refresh:hover, .dsh-wt-discard:hover:not(:disabled) {
  border-color: color-mix(in oklab, currentColor 44%, transparent);
}
.dsh-wt-discard:disabled { opacity: .6; cursor: default; }
.dsh-wt-discard[data-armed="true"] {
  border-color: color-mix(in oklab, #e5534b 60%, transparent);
  color: #e5534b;
}
.dsh-wt-project { display: flex; flex-direction: column; gap: 8px; }
.dsh-wt-project-head { display: flex; align-items: baseline; gap: 10px; }
.dsh-wt-project-head h3 { margin: 0; font-size: 13px; font-weight: 600; }
.dsh-wt-count { font-size: 11px; opacity: .64; }
.dsh-wt-path, .dsh-wt-row-path { font-size: 11px; opacity: .64; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-wt-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dsh-wt-row {
  display: grid; align-items: center; gap: 12px;
  grid-template-columns: minmax(120px, 1.2fr) minmax(120px, 1fr) minmax(160px, 1.6fr) auto auto auto;
  padding: 8px 12px; border-radius: 8px;
  border: 1px solid color-mix(in oklab, currentColor 12%, transparent);
}
.dsh-wt-name { font-weight: 600; }
.dsh-wt-branch, .dsh-wt-created, .dsh-wt-changes { font-size: 12px; }
.dsh-wt-changes[data-changes]:not([data-changes="0"]) { color: #bf8700; }
.dsh-wt-muted { opacity: .64; font-size: 12px; }
.dsh-wt-error { color: #e5534b; font-size: 12px; margin: 0; }
.dsh-wt-panel-icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 28px; height: 28px; border-radius: 8px; border: none; background: transparent;
  color: inherit; opacity: .68; cursor: pointer; padding: 0;
}
.dsh-wt-panel-icon:hover { opacity: 1; background: color-mix(in oklab, currentColor 8%, transparent); }
.dsh-wt-panel-icon[data-active="true"] { opacity: 1; background: color-mix(in oklab, currentColor 12%, transparent); }
`

/**
 * Install the stylesheet if this page has not installed it yet.
 * @returns a disposer that removes the element this call created.
 */
export function installStyles(): () => void {
  if (typeof document === 'undefined') return () => {}
  if (document.querySelector(`style[${STYLE_ATTRIBUTE}]`) !== null) return () => {}
  const style = document.createElement('style')
  style.setAttribute(STYLE_ATTRIBUTE, '')
  style.textContent = CSS
  document.head.appendChild(style)
  return () => { style.remove() }
}
