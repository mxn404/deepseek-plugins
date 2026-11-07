/**
 * Host half of the `/new` command plugin.
 *
 * The command itself is a browser contribution: the slash menu and the
 * new-Session navigation both live in the Web GUI, so this Host row only mounts
 * the package — which is enough for the client-module scanner to publish
 * `lib/client.js`, and for the plugin's lifecycle to follow the bundle.
 *
 * @module dsh-new-session
 */

import type { Context } from '@deepseek-ai/cordis'

/** Plugin id: package name, bundle row id, and browser module id. */
export const name = 'dsh-new-session'

/**
 * Mount the inert Host half.
 * @param ctx - the Cordis context.
 */
export function apply(ctx: Context): void {
  // No host-side capability on purpose: a Host handler could not move the
  // browser's current Session, so `/new` is a client-owned action instead.
  void ctx
}
