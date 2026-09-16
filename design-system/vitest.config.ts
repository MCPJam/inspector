import { defineConfig } from "vitest/config";

/**
 * The package had no config at all, so its suites ran on vitest's 5s default
 * while the client sets 30s. That is not enough for a `userEvent` sequence in
 * jsdom: measured, `npm run test -w @mcpjam/design-system` timed out on 4 of 12
 * runs, always on a different test. The root `test:parallel:rest` runs this
 * workspace under `concurrently --kill-others-on-fail`, so each of those killed
 * every other package's suite with it.
 *
 * The environment stays per FILE, not here: `tokens-parity` reads `tokens.css`
 * through `import.meta.url`, which jsdom rewrites to http: and `readFileSync`
 * then rejects.
 */
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
