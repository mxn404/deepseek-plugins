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
.dsh-wt-chip[data-position="on"] .dsh-wt-dot { background: #2da44e; }
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
  display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px;
  padding: 8px 12px; border-radius: 8px;
  border: 1px solid color-mix(in oklab, currentColor 12%, transparent);
}
.dsh-wt-name { font-weight: 600; min-width: 120px; }
.dsh-wt-branch { min-width: 120px; }
.dsh-wt-row-path { flex: 1 1 180px; min-width: 140px; }
.dsh-wt-row .dsh-wt-anchor { margin-left: auto; }
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
.dsh-wt-panel-icon { position: relative; }
.dsh-wt-panel-icon-count {
  position: absolute; top: -2px; right: -2px; min-width: 14px; height: 14px; padding: 0 3px;
  border-radius: 999px; background: #bf8700; color: #fff; font-size: 9px; line-height: 14px;
  font-weight: 600; text-align: center; pointer-events: none;
}
.dsh-wt-badge { display: inline-flex; align-items: center; }
.dsh-wt-badge-button {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 8px; border-radius: 999px;
  border: 1px solid color-mix(in oklab, currentColor 20%, transparent);
  background: transparent; color: inherit; font: inherit; font-size: 12px;
  line-height: 18px; cursor: pointer; white-space: nowrap;
  max-width: 220px; overflow: hidden; text-overflow: ellipsis;
}
.dsh-wt-badge-button:hover { border-color: color-mix(in oklab, currentColor 42%, transparent); }
.dsh-wt-badge-button:focus-visible { outline: 2px solid color-mix(in oklab, currentColor 45%, transparent); outline-offset: 1px; }
.dsh-wt-notice {
  position: absolute; left: 50%; bottom: 28px; transform: translateX(-50%);
  display: flex; align-items: center; gap: 12px; max-width: min(720px, calc(100vw - 40px));
  padding: 10px 14px; border-radius: 10px; pointer-events: auto;
  border: 1px solid color-mix(in oklab, #bf8700 55%, transparent);
  background: color-mix(in oklab, #1f2328 88%, transparent); color: #f0f6fc;
  font: inherit; font-size: 12px; line-height: 18px;
  box-shadow: 0 6px 20px color-mix(in oklab, #000 32%, transparent);
}
.dsh-wt-notice[data-kind="failed"] { border-color: color-mix(in oklab, #e5534b 60%, transparent); }
.dsh-wt-notice-text { flex: 1; min-width: 0; }
.dsh-wt-notice-open {
  border: 1px solid color-mix(in oklab, currentColor 40%, transparent);
  background: transparent; color: inherit; font: inherit; font-size: 12px;
  border-radius: 6px; padding: 3px 10px; cursor: pointer; white-space: nowrap;
}
.dsh-wt-notice-open:hover { border-color: currentColor; }
.dsh-wt-notice-dismiss {
  border: none; background: transparent; color: inherit; font: inherit; font-size: 15px;
  line-height: 1; cursor: pointer; padding: 2px 4px; opacity: .72;
}
.dsh-wt-notice-dismiss:hover { opacity: 1; }
.dsh-wt-row[data-current="true"] {
  border-color: color-mix(in oklab, #2da44e 55%, transparent);
  background: color-mix(in oklab, #2da44e 8%, transparent);
}
.dsh-wt-current {
  font-size: 11px; font-weight: 600; color: #2da44e;
  border: 1px solid color-mix(in oklab, #2da44e 45%, transparent);
  border-radius: 999px; padding: 0 8px; white-space: nowrap;
}
.dsh-wt-prunable {
  font-size: 11px; color: #bf8700; white-space: nowrap;
}
.dsh-wt-orphans { display: flex; flex-direction: column; gap: 6px; margin-top: 6px; }
.dsh-wt-orphans-head { display: flex; align-items: baseline; gap: 8px; }
.dsh-wt-orphans-head h4 { margin: 0; font-size: 12px; font-weight: 600; opacity: .86; }
.dsh-wt-orphan-rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.dsh-wt-orphan {
  display: grid; align-items: center; gap: 12px;
  grid-template-columns: minmax(120px, 1fr) minmax(150px, 1fr) minmax(160px, 1.6fr) auto auto;
  padding: 6px 12px; border-radius: 8px;
  border: 1px dashed color-mix(in oklab, currentColor 18%, transparent);
}
.dsh-wt-orphan-branch { font-size: 12px; font-weight: 600; }
.dsh-wt-orphan-commits, .dsh-wt-orphan-time { font-size: 12px; opacity: .78; }
.dsh-wt-orphan-subject { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-wt-orphan-delete {
  border: 1px solid color-mix(in oklab, currentColor 24%, transparent);
  background: transparent; color: inherit; font: inherit; font-size: 12px;
  border-radius: 6px; padding: 4px 10px; cursor: pointer; white-space: nowrap;
}
.dsh-wt-orphan-delete:hover:not(:disabled) { border-color: color-mix(in oklab, currentColor 44%, transparent); }
.dsh-wt-orphan-delete:disabled { opacity: .6; cursor: default; }
.dsh-wt-orphan-delete[data-armed="true"] {
  border-color: color-mix(in oklab, #e5534b 60%, transparent);
  color: #e5534b;
}
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
