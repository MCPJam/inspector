import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The bash tool's LOCAL branch and the hosted-omission contract, isolated
 * from the cloud-pipeline suite because both need module-level mocks: a
 * scratch homedir (never the developer's real ~/.mcpjam) and a controllable
 * HOSTED_MODE.
 */
const scratch = mkdtempSync(join(tmpdir(), "mcpjam-bash-local-"));
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => scratch };
});

const configState = vi.hoisted(() => ({ hosted: false }));
vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>(
    "../../config.js"
  );
  return {
    ...actual,
    get HOSTED_MODE() {
      return configState.hosted;
    },
    get LOCAL_COMPUTER_ENABLED() {
      // Mirrors the real derivation: forced off hosted.
      return !configState.hosted;
    },
  };
});

import { buildBashTool } from "../built-in-tools/bash";

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const toolOpts = {
  authHeader: "Bearer user-token",
  projectId: "proj_local_1",
  workdir: "/home/user/workspace", // E2B semantics — must be IGNORED locally
};

function execTool(tool: ReturnType<typeof buildBashTool>, command: string) {
  return (tool as any).execute(
    { command },
    { toolCallId: "call_local_1", abortSignal: undefined, messages: [] }
  );
}

describe("bash tool — local engine", () => {
  beforeEach(() => {
    configState.hosted = false;
  });

  it("executes on this machine, stamps engine:local, and never touches the control plane", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const e2bRunnerSpy = vi.fn();
      const tool = buildBashTool(
        { ...toolOpts, engine: "local" },
        e2bRunnerSpy
      );
      const result = await execTool(tool, "echo local-hi; pwd");
      expect(result.engine).toBe("local");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("local-hi");
      // The E2B `/home/user` workdir was ignored: we ran in the project
      // workspace under the (scratch) home.
      expect(result.stdout).toContain("proj_local_1");
      expect(result.stdout).not.toContain("/home/user/workspace");
      expect(e2bRunnerSpy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hosted turns never carry the engine field — transcripts stay byte-identical", async () => {
    configState.hosted = true;
    const runner = vi.fn();
    // Hosted + unconfigured control plane: the error result is the easiest
    // deterministic output — the contract is about the FIELD, not the path.
    const tool = buildBashTool({ ...toolOpts, engine: "unavailable" }, runner);
    const result = await execTool(tool, "ls");
    expect("engine" in result).toBe(false);
  });

  it("local errors still carry engine:local on non-hosted turns", async () => {
    const tool = buildBashTool(
      { ...toolOpts, engine: "unavailable", localEngineRequested: true },
      vi.fn()
    );
    const result = await execTool(tool, "ls");
    expect(result.error).toMatch(/local computer engine/i);
    // A failed explicit-local ask is a LOCAL story — a "cloud" badge on this
    // error would misattribute the failure.
    expect(result.engine).toBe("local");
  });
});
