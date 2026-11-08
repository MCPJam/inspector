/**
 * Runs the shipped sidecar source as a real process, for tests that need the
 * workspace half of the tunnel. The app under test listens on 127.0.0.2 so a
 * relay on 127.0.0.1 can take the same port number, as it does across boxes.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PREVIEW_TUNNEL_SOURCE } from "../tunnel-sidecar";

export const APP_HOST = "127.0.0.2";

export interface RunningSidecar {
  port: number;
  secret: string;
  stateMode: number;
  stop(): void;
}

export async function startSidecar(): Promise<RunningSidecar> {
  const dir = mkdtempSync(join(tmpdir(), "preview-tunnel-"));
  const script = join(dir, "tunnel.mjs");
  const state = join(dir, "state.json");
  writeFileSync(script, PREVIEW_TUNNEL_SOURCE);
  const secret = "a".repeat(64);
  const child: ChildProcess = spawn(process.execPath, [script], {
    env: {
      MCPJAM_PREVIEW_SECRET: secret,
      MCPJAM_PREVIEW_STATE: state,
      MCPJAM_PREVIEW_TARGET_HOST: APP_HOST,
    },
    stdio: "ignore",
  });
  for (let i = 0; i < 100 && !existsSync(state); i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  const parsed = JSON.parse(readFileSync(state, "utf8")) as { port: number };
  return {
    port: parsed.port,
    secret,
    stateMode: statSync(state).mode & 0o777,
    stop: () => child.kill(),
  };
}
