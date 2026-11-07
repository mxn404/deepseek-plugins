/**
 * Copy for the `/new` command's slash-menu row and execution notice.
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
  label: 'New session',
  description: 'Start a fresh conversation in this workspace',
}

/** Simplified Chinese copy. */
export const zh = {
  label: '新建会话',
  description: '在当前工作区开一个全新的对话',
}

/** Keys the command's row reads through the bound translate function. */
export type NewSessionKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by this plugin's `/new` command row. */
    newSession: NewSessionKey
  }
}
