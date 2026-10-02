import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createAccessLink,
  shouldPrintAccessLink,
  createLaunchToken,
  networkAccessLinks,
} from "../../bin/access-link.mjs";
test("hosted launch never delivers local credentials", () => {
  assert.equal(
    createLaunchToken({
      VITE_MCPJAM_HOSTED_MODE: "true",
      MCPJAM_SESSION_TOKEN: "configured",
    }),
    undefined,
  );
});
test("local launcher generates a credential and preserves tab navigation", () => {
  const token = createLaunchToken({});
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(
    createAccessLink("http://localhost:8080/", token, "tools"),
    `http://localhost:8080/#token=${token}&tab=tools`,
  );
  assert.notEqual(token, createLaunchToken({}));
  assert.equal(createLaunchToken({ MCPJAM_SESSION_TOKEN: token }), token);
  assert.throws(() => createLaunchToken({ MCPJAM_SESSION_TOKEN: "bad" }));
});
test("network links omit wildcards and retain the browser-facing port", () => {
  assert.deepEqual(
    networkAccessLinks(
      "http://localhost:8080",
      "test",
      "devbox.local,*.lan,[fd00::50]",
    ),
    [
      "http://devbox.local:8080/#token=test",
      "http://[fd00::50]:8080/#token=test",
    ],
  );
});

test("CLI-owned launches keep credentials out of redirected launcher logs", () => {
  assert.equal(
    shouldPrintAccessLink("private", {
      MCPJAM_INSPECTOR_SUPPRESS_AUTO_OPEN: "1",
    }),
    false,
  );
  assert.equal(shouldPrintAccessLink("private", {}), true);
  assert.equal(shouldPrintAccessLink(undefined, {}), false);
});
