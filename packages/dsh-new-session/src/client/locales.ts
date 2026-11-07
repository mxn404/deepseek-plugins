/**
 * Copy for the `/clear` command row and its `/new` alias.
 *
 * The dictionaries live in TypeScript, not in `locale/*.json`: those JSON files
 * are the market page's `meta.title` / `meta.description`, while menu copy is
 * registered with the browser locale registry at runtime. Keeping one key set
 * (`NewSessionKey`) means a missing translation is a compile error.
 *
 * @module dsh-new-session/client/locales
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** English copy. */
export const en = {
  'clear.label': 'Clear conversation',
  'clear.description': 'Start a fresh conversation here; the previous one stays in your history',
  'new.label': 'New session',
  'new.description': 'Same as /clear: start a fresh conversation here',
}

/** Simplified Chinese copy. */
export const zh = {
  'clear.label': '清除对话',
  'clear.description': '在这里开始全新对话，旧对话保留在历史里',
  'new.label': '新建会话',
  'new.description': '与 /clear 相同：在这里开始全新对话',
}

/** Keys the command rows read through the bound translate function. */
export type NewSessionKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by this plugin's `/clear` and `/new` rows. */
    newSession: NewSessionKey
  }
}
