/**
 * Force `ws` onto its pure-JS masker before anything imports it.
 *
 * The main process BUNDLES `ws` — it is not in `rollupOptions.external` in
 * vite.main.config.ts, and `src/main.ts` dynamically imports the whole server,
 * so `server/services/relay-client.ts` (tunnels) and `@hono/node-ws` (computer
 * terminals) both pull it into this bundle's graph.
 *
 * `ws` treats its optional peer deps as present-or-throwing: it requires
 * `bufferutil` inside a `try`, installs a native fast path on success, and
 * takes a thrown require as "no native module, stay on the JS fallback".
 *
 * `bufferutil` is not installed (it has no package-lock entry, and CI installs
 * with `npm ci`), so Vite resolves it to a frozen EMPTY namespace rather than
 * leaving the require unresolvable — `__viteOptionalPeerDep_bufferutil_ws_true`
 * in the emitted chunk. The require then SUCCEEDS and returns `{}`, `ws`
 * installs a fast path whose `.mask`/`.unmask` do not exist, and the process
 * dies with `mask is not a function`.
 *
 * That is issue #4208. `ws` only takes the native path above a size threshold
 * (48 bytes to mask, 32 to unmask), so the tunnel handshake and its 0-byte
 * heartbeat pings pass and the tunnel reports "connected" — while every real
 * MCP JSON-RPC message throws, uncaught, out of the relay's response pump.
 *
 * Setting the env var skips the probe entirely. The JS masker is a few XORs
 * per byte; nothing here moves enough traffic to notice.
 *
 * `WS_NO_UTF_8_VALIDATE` is belt-and-braces. `ws/lib/validation.js` prefers
 * `node:buffer`'s `isUtf8`, which exists on Electron's Node, so the
 * `utf-8-validate` branch is unreachable today — but it is stubbed identically
 * (`__viteOptionalPeerDep_utf8Validate_ws_true` is in the same chunk) and would
 * fail the same way if `ws` ever reordered those checks.
 *
 * Imported FIRST by main.ts: `ws` reads these at module-eval time, and this has
 * to win that race. forge.config.ts asserts the assignment survives into the
 * shipped bundle, because nothing below the bundler can see this class of bug.
 */
process.env.WS_NO_BUFFER_UTIL = "1";
process.env.WS_NO_UTF_8_VALIDATE = "1";

// Side effects only. Marks the file as a module so it can be `import()`ed
// under `isolatedModules` — the test clears both vars, then imports.
export {};
