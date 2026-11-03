/**
 * Copy for the switch and the panel, in both shipped locales.
 * @module dsh-worktree-toggle/client/locales
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** English dictionary; its keys are the namespace's key domain. */
export const en = {
  'chip.label': 'Worktree copy for this session',
  'chip.checking': 'Worktree…',
  'chip.off': 'Worktree off',
  'chip.creating': 'Creating worktree…',
  'chip.ready': 'Worktree: {name}',
  'chip.failed': 'Worktree failed',
  'chip.retry': 'Retry',
  'chip.disabled': 'Worktree unavailable',
  'chip.hint.checking': 'Checking whether this project can be isolated…',
  'chip.hint.off': 'New sessions in this project start in the project directory.',
  'chip.hint.on': 'This session runs in a copy of the project; the source checkout is untouched.',
  'chip.hint.creating': 'Creating a checkout under {pool}…',
  'chip.hint.ready': 'Branch {branch} at {path}',
  'chip.hint.failed': 'The copy was not created, so this session is still in the project directory.',
  'chip.hint.disabled': 'This project is not a Git repository, so there is nothing to copy.',
  'chip.hint.dirty': 'The source checkout has {count} uncommitted change(s); the copy starts from the last commit.',
  'chip.hint.intentOff': 'Applies to the next session; this one keeps {name}.',
  'chip.blocked.checking': 'Checking whether this session gets a worktree…',
  'chip.blocked.creating': 'Creating the worktree before the first prompt…',
  'chip.blocked.failed': 'The worktree could not be created. Retry, turn the switch off, or discard the failed copy first.',
  'panel.title': 'Worktrees',
  'panel.subtitle': 'Copies created by the Worktree toggle: one checkout and one branch each. Discard removes both.',
  'panel.refresh': 'Refresh',
  'panel.back': 'Back',
  'panel.loading': 'Reading worktrees…',
  'panel.empty': 'No worktrees here yet.',
  'panel.workspaceEmpty': 'No projects yet. Open a session to give this panel something to read.',
  'panel.error': 'Could not read worktrees: {message}',
  'panel.notRepository': 'Not a Git repository.',
  'panel.name': 'Name',
  'panel.branch': 'Branch',
  'panel.created': 'Created',
  'panel.changes': 'Changes',
  'panel.changesCount': '{count} uncommitted',
  'panel.clean': 'Clean',
  'panel.discard': 'Discard',
  'panel.discardAgain': 'Discard now',
  'panel.discardHint': 'Deletes the checkout and its branch.',
  'panel.discardDirty': 'Commit or discard its changes first.',
  'panel.count': '{count} copies',
  'sidebar.label': 'Worktrees',
} as const

/** Translation key domain of the {@link en} namespace. */
export type WorktreeToggleKey = keyof typeof en

/** Chinese dictionary: every key of {@link en}. */
export const zh: Record<WorktreeToggleKey, string> = {
  'chip.label': '本会话使用 Worktree 副本',
  'chip.checking': 'Worktree…',
  'chip.off': 'Worktree 已关',
  'chip.creating': '正在创建 Worktree…',
  'chip.ready': 'Worktree：{name}',
  'chip.failed': 'Worktree 创建失败',
  'chip.retry': '重试',
  'chip.disabled': 'Worktree 不可用',
  'chip.hint.checking': '正在检查这个项目能否隔离…',
  'chip.hint.off': '这个项目的新会话直接在项目目录里开始。',
  'chip.hint.on': '本会话在项目的一份副本里运行，源仓库不受影响。',
  'chip.hint.creating': '正在 {pool} 下创建检出…',
  'chip.hint.ready': '分支 {branch}，位于 {path}',
  'chip.hint.failed': '副本没有创建成功，本会话仍然在项目目录里。',
  'chip.hint.disabled': '这个项目不是 Git 仓库，没有可复制的内容。',
  'chip.hint.dirty': '源仓库有 {count} 处未提交改动；副本会从最后一次提交开始。',
  'chip.hint.intentOff': '仅对下一个会话生效；本会话仍然使用 {name}。',
  'chip.blocked.checking': '正在检查本会话是否需要 Worktree…',
  'chip.blocked.creating': '正在创建 Worktree，副本就绪前暂停发送…',
  'chip.blocked.failed': 'Worktree 创建失败。请重试、关闭开关，或先丢弃失败的副本。',
  'panel.title': 'Worktree',
  'panel.subtitle': 'Worktree 开关创建的副本：每份副本是一个检出加一个分支，丢弃会同时删掉两者。',
  'panel.refresh': '刷新',
  'panel.back': '返回',
  'panel.loading': '正在读取 Worktree…',
  'panel.empty': '这里还没有 Worktree。',
  'panel.workspaceEmpty': '还没有项目。打开一个会话，这里才有可读的内容。',
  'panel.error': '读取 Worktree 失败：{message}',
  'panel.notRepository': '不是 Git 仓库。',
  'panel.name': '名称',
  'panel.branch': '分支',
  'panel.created': '创建时间',
  'panel.changes': '改动',
  'panel.changesCount': '{count} 处未提交',
  'panel.clean': '干净',
  'panel.discard': '丢弃',
  'panel.discardAgain': '确认丢弃',
  'panel.discardHint': '删除检出目录和它的分支。',
  'panel.discardDirty': '请先提交或丢弃其中的改动。',
  'panel.count': '{count} 份副本',
  'sidebar.label': 'Worktree',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by this plugin. */
    worktreeToggle: WorktreeToggleKey
  }
}
