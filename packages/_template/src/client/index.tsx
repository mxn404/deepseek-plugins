/**
 * Browser half: runs in the Web GUI page, never in the Host.
 *
 * The Host publishes this module from `exports["./client"]` because
 * `package.json` declares `dsh.client`. Anything imported at runtime from
 * `@deepseek-ai/*`, `react` or `react-dom` resolves through the page's frozen
 * platform module table, so the client build keeps those external. Extra module
 * requests go in `dsh.client.external`.
 *
 * This file has no runtime import yet, so it builds to a near-empty bundle.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Browser module id. Keep it equal to the package name. */
export const name = 'dsh-plugin-template'

/**
 * Browser half entry.
 *
 * @param ctx - the browser-side Cordis context; UI slots and sidebar tabs are
 * registered here once the matching client services are injected.
 */
export function apply(ctx: Context): void {
  // Add `inject` and register UI through `ctx.slots`, `ctx.sidebarRight`, … once
  // this plugin actually renders something.
  void ctx
}
