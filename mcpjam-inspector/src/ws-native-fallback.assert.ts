import { resolve } from "path";

export type ReadFsBits = {
  existsSync: (p: string) => boolean;
  readdirSync: (p: string) => string[];
  statSync: (p: string) => { isDirectory: () => boolean };
  readFileSync: (p: string, enc: "utf8") => string;
};

/**
 * Fail the package if the bundled `ws` would use Vite's empty stub for its
 * optional `bufferutil` dep (#4208).
 *
 * `ws` decides "no native masker" by `require('bufferutil')` THROWING. Vite
 * resolves an absent optional peer dep to a frozen empty namespace instead, so
 * the require succeeds, `ws` installs a fast path whose `.mask`/`.unmask` are
 * undefined, and every WebSocket frame over the size threshold throws —
 * silently killing tunnels while the handshake still looks healthy.
 *
 * `src/ws-native-fallback.ts` fixes that by setting `WS_NO_BUFFER_UTIL` before
 * `ws` loads. Nothing below the bundler can verify it: the stub only exists
 * after bundling, and the packaged tree is the one place both halves are
 * visible at once. So assert on the artifact — if the stub is in the graph, the
 * assignment that neutralizes it has to be there too.
 *
 * Note the assertion is "fix present", not "stub absent": the fix stops `ws`
 * from USING the stub, it does not remove it from the bundle.
 *
 * Lives beside the fix rather than in forge.config.ts so both halves of the
 * contract are testable; forge.config.ts imports it (jiti loads that config,
 * so a relative TS import resolves).
 */
export function assertWsNativeFallback(buildDir: string, fs: ReadFsBits): void {
  if (!fs.existsSync(buildDir)) return;

  const chunks: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = resolve(dir, entry);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".cjs") || entry.endsWith(".js"))
        chunks.push(fs.readFileSync(full, "utf8"));
    }
  };
  walk(buildDir);

  const stubbed = chunks.some((c) =>
    c.includes("__viteOptionalPeerDep_bufferutil_ws"),
  );
  if (!stubbed) return;

  // An ASSIGNMENT, not `ws`'s own `!process.env.WS_NO_BUFFER_UTIL` read — that
  // read is in every bundle containing `ws` and proves nothing.
  //
  // Anchored on `process.env.` and on a NON-EMPTY literal: `ws` gates on
  // `!process.env.WS_NO_BUFFER_UTIL`, so `= ""` would satisfy a looser pattern
  // while leaving the probe — and the bug — fully in place. Any non-empty
  // string is truthy and does neutralize it, `"0"` included. Verified against
  // the real minified bundle, which emits `process.env.WS_NO_BUFFER_UTIL="1"`.
  const neutralized = chunks.some((c) =>
    /process\.env\.WS_NO_BUFFER_UTIL\s*=\s*(["'])(?!\1)/.test(c),
  );
  if (neutralized) return;

  throw new Error(
    `[forge] ${buildDir} bundles an empty \`bufferutil\` stub for \`ws\` with ` +
      "nothing setting WS_NO_BUFFER_UTIL. Every WebSocket frame >= 48 bytes " +
      "would throw `mask is not a function`, and tunnels would die silently " +
      "(#4208). Restore the `./ws-native-fallback.js` import at the top of " +
      "src/main.ts."
  );
}
