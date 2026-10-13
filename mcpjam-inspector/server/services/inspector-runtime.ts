import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getSessionToken } from "./session-token.js";

/** Same-user discovery for CLI attachment; never served by the web app. */
export function writeInspectorRuntime(
  port: number,
  options: {
    hosted?: boolean;
    docker?: boolean;
    home?: string;
    warn?: (message: string) => void;
  } = {},
): () => void {
  if (
    options.hosted ||
    (options.docker ?? process.env.DOCKER_CONTAINER === "true")
  )
    return () => {};
  try {
    return writeRuntimeFile(port, options.home);
  } catch {
    // Discovery is optional. An unwritable home must not stop the server or
    // expose the credential in an error sent to telemetry.
    options.warn?.(
      "Could not write Inspector discovery file; local CLI attachment is unavailable. Use the access link to open Inspector.",
    );
    return () => {};
  }
}

function writeRuntimeFile(port: number, home?: string): () => void {
  const token = getSessionToken();
  if (!token)
    throw new Error("Inspector session must be initialized before discovery");
  const directory = join(home ?? homedir(), ".mcpjam", "inspector");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const file = join(directory, `${port}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({
        port,
        pid: process.pid,
        token,
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600, flag: "wx" },
    );
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
  const cleanup = () => {
    try {
      const current = JSON.parse(readFileSync(file, "utf8"));
      // A previous process must never remove a newer instance's discovery.
      if (current.pid === process.pid && current.token === token)
        unlinkSync(file);
    } catch {}
    process.removeListener("exit", cleanup);
  };
  process.once("exit", cleanup);
  return cleanup;
}
