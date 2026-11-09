/**
 * The host differences the plugin's other modules branch on.
 *
 * Every decision here is a pure function of an explicit platform value, so a
 * Linux test can exercise the Windows branch and the platform default is only
 * read at the one place that has to read it. The plugin has no other
 * `process.platform` check: keeping them here stops the Windows assumptions
 * from scattering into Git, path, and process code.
 * @module dsh-worktree-switch/host/platform
 */

/** The platform flavors this plugin distinguishes. */
export type HostPlatform = 'win32' | 'posix'

/**
 * The platform the host process runs on, folded to the two flavors above.
 * @returns `'win32'` on native Windows, `'posix'` everywhere else.
 */
export function hostPlatform(): HostPlatform {
  return process.platform === 'win32' ? 'win32' : 'posix'
}

/**
 * The null device a child process can be pointed at.
 *
 * `core.hooksPath` needs a path that runs no hooks rather than a disabled
 * setting; the OS-specific device name is the portable way to say "nothing".
 * @param platform - platform whose device name to return.
 * @returns `NUL` on win32, `/dev/null` elsewhere.
 */
export function nullDevice(platform: HostPlatform = hostPlatform()): string {
  return platform === 'win32' ? 'NUL' : '/dev/null'
}
