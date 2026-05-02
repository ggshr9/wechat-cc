/**
 * dependency-cruiser config — enforces module-boundary rules introduced
 * in PR5 of the architecture cleanup. Run via `bun run depcheck`.
 *
 * Layered architecture (top → bottom; higher layers may import lower):
 *
 *   src/cli/           ← CLI subcommand handlers (only `cli.ts` invokes these)
 *   src/daemon/        ← Long-running runtime (ilink, internal-api, schedulers)
 *   src/mcp-servers/   ← Standalone stdio MCP children (talk to daemon via HTTP)
 *   src/core/          ← Provider abstraction, conversation coordinator (no I/O)
 *   src/lib/           ← Shared utilities + send-reply (used by both cli + daemon)
 *
 * Cross-layer rules:
 *   - lib MUST NOT import from cli, daemon, core, mcp-servers (it's the floor)
 *   - core MUST NOT import from cli, daemon, mcp-servers (platform-agnostic)
 *   - mcp-servers MUST NOT import from cli, daemon (talks via internal-api HTTP)
 *   - cli MUST NOT import from daemon (daemon is a runtime, cli is a launcher
 *     of subcommands; if they need the daemon they should spawn it, not link)
 *   - daemon MAY import from cli (for the moment — handoff.ts, etc.). Tighten later.
 *
 * Tests (*.test.ts) are exempt — integration tests legitimately cross
 * boundaries (e.g. mcp-servers/wechat/integration.test.ts spins up the
 * full daemon internal-api).
 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'warn',
      comment: 'Circular dependencies hide architectural mistakes. Refactor.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'lib-must-not-depend-on-anything-internal',
      severity: 'error',
      comment: 'src/lib/ is the bottom of the dependency tree — utilities only.',
      from: { path: '^src/lib/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(cli|daemon|core|mcp-servers)/' },
    },
    {
      name: 'core-must-not-depend-on-runtime',
      severity: 'error',
      comment: 'src/core/ is platform-agnostic; runtime modules (cli/daemon/mcp) belong above it.',
      from: { path: '^src/core/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(cli|daemon|mcp-servers)/' },
    },
    {
      name: 'mcp-servers-must-not-link-daemon',
      severity: 'error',
      comment: 'MCP servers are independent stdio subprocesses — they talk to the daemon over HTTP, not by linking.',
      from: { path: '^src/mcp-servers/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/(cli|daemon)/' },
    },
    {
      name: 'cli-must-not-depend-on-daemon',
      severity: 'error',
      comment: 'CLI subcommand handlers are short-lived; they should spawn the daemon, not link to its internals.',
      from: { path: '^src/cli/', pathNot: '\\.test\\.ts$' },
      to: { path: '^src/daemon/' },
    },
    {
      name: 'no-orphans',
      severity: 'warn',
      comment: 'Unreachable files are usually dead code. Verify and delete.',
      from: { orphan: true, pathNot: '(\\.test\\.ts|\\.d\\.ts|tsconfig\\.json|\\.dependency-cruiser\\.cjs)$' },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: '(node_modules|docs/spike|apps/desktop/src-tauri|dist)',
    },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
}
