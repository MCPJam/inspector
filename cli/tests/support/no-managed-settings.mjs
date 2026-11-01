/**
 * Loaded into every CLI test process, and each process it spawns, by
 * `scripts/run-tests.mjs`. Points the IT settings file at a path that does not
 * exist, so a file installed on the machine running the tests cannot lock or
 * invalidate them. A process test that needs a file sets
 * MCPJAM_TEST_MANAGED_SETTINGS for the network guard instead.
 */
import os from "node:os";
import path from "node:path";

const seam = Symbol.for("mcpjam.managedSettingsPath");
if (typeof globalThis[seam] !== "string") {
  globalThis[seam] = path.join(
    os.tmpdir(),
    "mcpjam-tests-no-managed-settings",
    "managed-settings.json"
  );
}
