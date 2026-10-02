import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";

// These command tests spawn the built CLI, so discovery must also work in
// the subprocess. Keep all files in an isolated home, never the user's home.
const home = mkdtempSync(path.join(os.tmpdir(), "cli-inspector-home-"));
const previousHome = process.env.HOME;
const previousProfile = process.env.USERPROFILE;
process.env.HOME = home;
process.env.USERPROFILE = home;
after(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
  rmSync(home, { recursive: true, force: true });
});
export function provisionInspectorRuntime(port: number) {
  const directory = path.join(home, ".mcpjam", "inspector");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    path.join(directory, `${port}.json`),
    JSON.stringify({
      port,
      pid: process.pid,
      token: "inspector-command-test-credential",
      startedAt: new Date().toISOString(),
    }),
    { mode: 0o600 }
  );
}
