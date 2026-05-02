/**
 * config.ts — shared constants and paths.
 *
 * Values that are identical across multiple entry points live here.
 * Per-file overrides (e.g. different CLIENT_VERSION or API_TIMEOUT) stay
 * in the respective files — see the note on CLIENT_VERSION below.
 */

import { homedir } from 'os'
import { join } from 'path'

/** Root state directory — all persistent wechat-cc data lives under here. */
export const STATE_DIR = process.env.WECHAT_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'wechat')

/** ilink API base URL (shared by server + setup). */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** ilink app identifier. */
export const ILINK_APP_ID = 'bot'

/** Bot type for QR code generation. */
export const ILINK_BOT_TYPE = '3'

/** Long-poll timeout in ms (getupdates blocks for up to this long). */
export const LONG_POLL_TIMEOUT_MS = 35_000

/** Max chars per outbound text chunk — ilink rejects bodies larger than this. */
export const MAX_TEXT_CHUNK = 4000

/** Project registry — alias → path mapping + current active project. */
export const PROJECTS_FILE = join(STATE_DIR, 'projects.json')

/**
 * User cwd at wechat-cc run time. cli.ts writes this so server.ts (whose
 * own process.cwd() is the plugin dir, not the user's project) knows where
 * the user actually is. Used for /project status display, currentSessionJsonl
 * lookup, and auto-repair of registry current on startup.
 */
export const CURRENT_CWD_FILE = join(STATE_DIR, 'current-cwd')

/**
 * Note: ILINK_CLIENT_VERSION ('131335' = 0x00020107 = v2.1.7) is declared
 * in ilink.ts (for server runtime) and setup.ts (for QR login). Both now
 * use the same value. It's not in config.ts because only those two files
 * need it, and keeping it local makes the dependency explicit.
 *
 * API_TIMEOUT_MS differs by design: ilink.ts uses 30s (heavier bot API
 * calls), setup.ts uses 15s (lighter QR status polls).
 */
