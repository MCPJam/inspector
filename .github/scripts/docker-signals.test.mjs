import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(
  new URL("../../mcpjam-inspector/Dockerfile", import.meta.url),
  "utf8",
);
const finalStage = dockerfile.split(/^FROM base AS final$/m)[1] ?? "";

// `npm start` as PID 1 exits on SIGTERM before the server's graceful shutdown
// runs, and the container takes the server with it: in-flight harness turns
// then leave their backend locks to expire on their own.
test("the inspector image starts node directly so SIGTERM reaches the server", () => {
  const starts = finalStage
    .split("\n")
    .filter((line) => /^(ENTRYPOINT|CMD)\b/.test(line));
  assert.deepEqual(starts, ['ENTRYPOINT ["node", "bin/start.js"]']);
  // What `npm start` used to add.
  assert.match(finalStage, /^ENV NODE_ENV=production$/m);
});
