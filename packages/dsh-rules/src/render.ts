/**
 * Model-facing rendering for rule injection.
 *
 * Everything the model sees goes through here: one `<system-reminder>` frame,
 * always-on rule bodies, the session-start rule index, and triggered bodies.
 * The frame shape mirrors the host's own AGENTS.md injection.
 *
 * @module dsh-rules/render
 */

import { isAbsolute, relative } from 'node:path'
import type { Rule } from './rule.ts'

const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'

/** Intro shown before always-on rule bodies at session start. */
export const ALWAYS_ON_INTRO = 'The following repository rules apply to this workspace. '
  + 'Use them as guidance when applicable. More specific rules take precedence over broader ones. '
  + 'They do not override system, developer, or direct user instructions.'

/** Intro shown before triggered rule bodies. */
export const TRIGGER_INTRO = 'The following repository rules apply to files you just touched. '
  + 'Use them as guidance when applicable. They do not override system, developer, or direct user instructions.'

/** Intro shown before rule bodies replayed after a conversation compaction. */
export const REPLAY_INTRO = 'The following repository rules were loaded earlier in this session and are restated '
  + 'here because the conversation was compacted. Use them as guidance when applicable. '
  + 'They do not override system, developer, or direct user instructions.'

/** Intro shown before the session-start rule index. */
export const INDEX_INTRO = 'Repository rule index: path-scoped rules load automatically '
  + 'when you read, write, or edit a matching file.'

/** One triggered rule and the touched files that selected it. */
export interface TriggeredRule {
  readonly rule: Rule
  readonly triggeredBy: readonly string[]
}

/** Everything one injection message can carry. */
export interface ReminderContent {
  readonly alwaysOn: readonly Rule[]
  readonly index: string | undefined
  readonly triggered: readonly TriggeredRule[]
  readonly replayed: readonly Rule[]
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Convert an absolute path to the workspace-relative display path.
 * @param projectRoot - project root used as the display base.
 * @param absolutePath - absolute path to display.
 * @returns project-root-relative path, or the absolute path when outside the project.
 */
export function displayPath(projectRoot: string, absolutePath: string): string {
  const rel = relative(projectRoot, absolutePath)
  if (rel.length === 0 || isAbsolute(rel) || rel.split(/[\\/]/)[0] === '..') return absolutePath
  return rel.split(/[\\/]/).join('/')
}

/** Index rendering stage, from richest to most compact. */
type IndexMode = 'full' | 'paths' | 'names'

/**
 * Rules named in the index: every path-scoped rule plus every rule that failed
 * closed. Usable always-on rules are injected in full and need no index entry.
 * @param rules - discovered rules.
 * @returns true when the index has at least one line.
 */
export function hasIndexEntries(rules: readonly Rule[]): boolean {
  return rules.some(rule => rule.status !== 'ok' || rule.paths.length > 0)
}

function indexLine(rule: Rule, mode: IndexMode): string {
  if (rule.status !== 'ok') return `- ${rule.name} — unavailable (${rule.reason})`
  if (mode === 'names') return `- ${rule.name}`
  const paths = rule.paths.length > 0 ? rule.paths.join(', ') : '(none)'
  if (mode === 'full' && rule.title.length > 0) {
    return `- ${rule.name} — ${rule.title} — paths: ${paths}`
  }
  return `- ${rule.name} — paths: ${paths}`
}

function renderIndexAt(rules: readonly Rule[], mode: IndexMode): string {
  return [INDEX_INTRO, '', ...rules.map(rule => indexLine(rule, mode))].join('\n')
}

/**
 * Render the session-start rule index within its own byte budget.
 *
 * Degradation is ordered: titles, then path scopes, then the whole index. An
 * index that still does not fit is not injected at all; the caller logs that.
 * @param rules - discovered rules in deterministic order.
 * @param budget - maximum UTF-8 bytes of the rendered index.
 * @returns the index text, or `undefined` when it cannot fit or has no entries.
 */
export function renderRuleIndex(rules: readonly Rule[], budget: number): string | undefined {
  const entries = rules.filter(rule => rule.status !== 'ok' || rule.paths.length > 0)
  if (entries.length === 0) return undefined
  for (const mode of ['full', 'paths', 'names'] as const) {
    const text = renderIndexAt(entries, mode)
    if (byteLength(text) <= budget) return text
  }
  return undefined
}

function alwaysOnSection(rule: Rule, projectRoot: string): string {
  return [
    `Repository rule (always on): ${rule.name}`,
    `Source: ${displayPath(projectRoot, rule.absolutePath)}`,
    '',
    rule.body,
  ].join('\n')
}

function triggeredSection(entry: TriggeredRule, projectRoot: string): string {
  const triggeredBy = entry.triggeredBy.map(path => displayPath(projectRoot, path)).join(', ')
  return [
    `Repository rule: ${entry.rule.name}`,
    `Source: ${displayPath(projectRoot, entry.rule.absolutePath)}`,
    `Triggered by: ${triggeredBy}`,
    '',
    entry.rule.body,
  ].join('\n')
}

function replayedSection(rule: Rule, projectRoot: string): string {
  return [
    `Repository rule (replayed): ${rule.name}`,
    `Source: ${displayPath(projectRoot, rule.absolutePath)}`,
    '',
    rule.body,
  ].join('\n')
}

/**
 * Render one injection message body inside the host's reminder frame.
 * @param content - always-on rules, index text, triggered rules, and replayed rules.
 * @param projectRoot - display base for source and triggering paths.
 * @returns the framed message text, or `undefined` when there is nothing to say.
 */
export function renderReminder(content: ReminderContent, projectRoot: string): string | undefined {
  const blocks: string[] = []
  if (content.alwaysOn.length > 0) {
    blocks.push([
      ALWAYS_ON_INTRO,
      ...content.alwaysOn.map(rule => alwaysOnSection(rule, projectRoot)),
    ].join('\n\n'))
  }
  if (content.index !== undefined) blocks.push(content.index)
  if (content.triggered.length > 0) {
    blocks.push([
      TRIGGER_INTRO,
      ...content.triggered.map(entry => triggeredSection(entry, projectRoot)),
    ].join('\n\n'))
  }
  if (content.replayed.length > 0) {
    blocks.push([
      REPLAY_INTRO,
      ...content.replayed.map(rule => replayedSection(rule, projectRoot)),
    ].join('\n\n'))
  }
  if (blocks.length === 0) return undefined
  const body = blocks.join('\n\n').replaceAll(REMINDER_CLOSE, '<\\/system-reminder>')
  return [REMINDER_OPEN, body, REMINDER_CLOSE].join('\n')
}
