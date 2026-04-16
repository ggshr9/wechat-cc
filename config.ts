/**
 * config.ts — shared ilink constants.
 *
 * Values that are identical between server.ts and setup.ts live here.
 * Per-file overrides (e.g. different CLIENT_VERSION or API_TIMEOUT) stay
 * in the respective files — see the note on CLIENT_VERSION below.
 */

/** ilink API base URL (shared by server + setup). */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** ilink app identifier. */
export const ILINK_APP_ID = 'bot'

/** Bot type for QR code generation. */
export const ILINK_BOT_TYPE = '3'

/** Long-poll timeout in ms (getupdates blocks for up to this long). */
export const LONG_POLL_TIMEOUT_MS = 35_000

/**
 * Note: ILINK_CLIENT_VERSION is intentionally NOT shared here.
 *
 * server.ts uses '131335' (0x00020107, version 2.1.7 encoding), while
 * setup.ts uses '65547'. The discrepancy may be intentional (different
 * client handshake modes) or a stale value in one of the two files.
 * Unifying them requires testing against ilink — doing it blindly risks
 * breaking either the poll loop or the QR login flow. Left as a TODO
 * for when someone has time to verify which value is correct for each
 * endpoint.
 *
 * Similarly, API_TIMEOUT_MS differs by design: server.ts uses 30s
 * (heavier ilink calls), setup.ts uses 15s (lighter status polls).
 */
