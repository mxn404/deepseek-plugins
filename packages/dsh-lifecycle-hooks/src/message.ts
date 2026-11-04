/**
 * One rendering of a caught value, shared by every module that has to put an
 * error into a log line, a warning, or a protocol failure.
 *
 * A thrown value is not necessarily an `Error`: the host and foreign hook code
 * throw arbitrary values, and a `Error` with an empty message still has a
 * usable name. The helper keeps the message single-line so a warning stays one
 * record.
 *
 * @module dsh-lifecycle-hooks/message
 */

/**
 * Render one caught value for a log line, warning, or failure message.
 * @param error - anything thrown or reported.
 * @returns a single-line description; the empty string only when the value renders as
 * one (an empty-string throw or an object with no usable `message`).
 */
export function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message.length > 0 ? error.message : error.name
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return String(error)
}
