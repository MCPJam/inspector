import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveStdioLaunch,
  createStdioCommandApprovalStore,
  readChangedEnvNames,
  readStdioLaunchApproval,
  stdioCommandApprovalRequired,
  stdioLaunchFingerprint,
} from "../stdio-command-approvals.js";

const BASE = {
  command: "node",
  args: ["server.js", "--port", "3000"],
  env: { FOO: "bar", BAZ: "1" },
};

describe("stdioLaunchFingerprint", () => {
  it("is a SHA-256 hex digest", () => {
    expect(stdioLaunchFingerprint(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not depend on env key order", () => {
    expect(
      stdioLaunchFingerprint({ ...BASE, env: { BAZ: "1", FOO: "bar" } }),
    ).toBe(stdioLaunchFingerprint(BASE));
  });

  it.each([
    ["the command", { ...BASE, command: "npx" }],
    ["an arg", { ...BASE, args: ["server.js", "--port", "3001"] }],
    ["arg order", { ...BASE, args: ["--port", "3000", "server.js"] }],
    ["an env value", { ...BASE, env: { ...BASE.env, FOO: "evil" } }],
    ["an env name", { ...BASE, env: { ...BASE.env, NODE_OPTIONS: "" } }],
    ["the working directory", { ...BASE, cwd: "/tmp" }],
  ])("changes when %s changes", (_label, spec) => {
    expect(stdioLaunchFingerprint(spec)).not.toBe(stdioLaunchFingerprint(BASE));
  });
});

describe("stdio command approval store", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "stdio-approvals-"));
    file = join(dir, "nested", "approvals.json");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it("reports none for a server this device never approved", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    expect(await store.read("srv-1", stdioLaunchFingerprint(BASE))).toBe(
      "none",
    );
  });

  it("reports approved after approving the same fingerprint", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    const fingerprint = stdioLaunchFingerprint(BASE);
    await store.approve("srv-1", BASE);
    expect(await store.read("srv-1", fingerprint)).toBe("approved");
  });

  it("reports changed when the stored fingerprint differs", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    await store.approve("srv-1", BASE);
    expect(
      await store.read(
        "srv-1",
        stdioLaunchFingerprint({ ...BASE, args: ["evil.js"] }),
      ),
    ).toBe("changed");
  });

  it("replaces the stored fingerprint on re-approval", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    const first = stdioLaunchFingerprint(BASE);
    const second = stdioLaunchFingerprint({ ...BASE, args: ["v2.js"] });
    await store.approve("srv-1", BASE);
    await store.approve("srv-1", { ...BASE, args: ["v2.js"] });
    expect(await store.read("srv-1", second)).toBe("approved");
    expect(await store.read("srv-1", first)).toBe("changed");
  });

  it("keeps other servers' approvals when approving one", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    const fingerprint = stdioLaunchFingerprint(BASE);
    await store.approve("srv-1", BASE);
    await store.approve("srv-2", BASE);
    expect(await store.read("srv-1", fingerprint)).toBe("approved");
    expect(await store.read("srv-2", fingerprint)).toBe("approved");
  });

  it("treats an unreadable file as no approvals", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    await store.approve("srv-1", BASE);
    await writeFile(file, "{not json");
    expect(await store.read("srv-1", stdioLaunchFingerprint(BASE))).toBe(
      "none",
    );
  });

  it("refuses to approve over a file it cannot read, keeping the other approvals", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const store = createStdioCommandApprovalStore(() => file);
    await store.approve("srv-1", BASE);
    await chmod(file, 0o000);
    await expect(store.approve("srv-2", BASE)).rejects.toThrow();
    await chmod(file, 0o600);
    expect(await store.read("srv-1", stdioLaunchFingerprint(BASE))).toBe(
      "approved",
    );
  });

  it("writes the file readable by the owner only", async () => {
    if (process.platform === "win32") return;
    const store = createStdioCommandApprovalStore(() => file);
    await store.approve("srv-1", BASE);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("names the env variables that are new or hold another value since the last approval", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    await store.approve("srv-1", BASE);
    expect(
      await store.changedEnvNames("srv-1", {
        FOO: "evil",
        BAZ: "1",
        NODE_OPTIONS: "--require=/tmp/x.js",
      }),
    ).toEqual(["FOO", "NODE_OPTIONS"]);
    expect(await store.changedEnvNames("srv-1", BASE.env)).toEqual([]);
  });

  it("names an env variable removed since the last approval", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    await store.approve("srv-1", BASE);
    expect(await store.changedEnvNames("srv-1", { FOO: "bar" })).toEqual([
      "BAZ",
    ]);
  });

  it("keeps env values out of the file", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    await store.approve("srv-1", {
      ...BASE,
      env: { TOKEN: "secret-value-123" },
    });
    expect(await readFile(file, "utf8")).not.toContain("secret-value-123");
  });

  it("the default store follows MCPJAM_STDIO_APPROVALS_FILE", async () => {
    const custom = join(dir, "custom.json");
    vi.stubEnv("MCPJAM_STDIO_APPROVALS_FILE", custom);
    const fingerprint = stdioLaunchFingerprint(BASE);
    await approveStdioLaunch("srv-1", BASE);
    expect(await readStdioLaunchApproval("srv-1", fingerprint)).toBe(
      "approved",
    );
    expect(
      await readChangedEnvNames("srv-1", { ...BASE.env, FOO: "evil" }),
    ).toEqual(["FOO"]);
    const persisted = JSON.parse(await readFile(custom, "utf8"));
    expect(persisted.approvals["srv-1"].fingerprint).toBe(fingerprint);
  });
});

describe("stdioCommandApprovalRequired", () => {
  it("builds a 403 whose details carry the terms but never env values", () => {
    const fingerprint = "ab".repeat(32);
    const error = stdioCommandApprovalRequired({
      serverId: "srv-1",
      serverDisplayName: "Files",
      spec: {
        command: "node",
        args: ["server.js"],
        env: { TOKEN: "secret-value" },
        cwd: "/srv",
      },
      fingerprint,
      approval: "changed",
      changedEnvNames: ["TOKEN"],
    });

    expect(error.status).toBe(403);
    expect(error.code).toBe("STDIO_COMMAND_APPROVAL_REQUIRED");
    expect(error.message).toContain('"Files"');
    expect(error.details).toEqual({
      reason: "stdio_command_approval_required",
      serverId: "srv-1",
      serverName: "Files",
      approval: {
        serverId: "srv-1",
        fingerprint,
        command: "node",
        args: ["server.js"],
        envNames: ["TOKEN"],
        changedEnvNames: ["TOKEN"],
        cwd: "/srv",
        previouslyApproved: true,
      },
    });
    expect(JSON.stringify(error.details)).not.toContain("secret-value");
    // Not the status-only "Forbidden (403)" block with OAuth next steps.
    expect(error.normalized).toMatchObject({
      title: "Command not approved on this device",
      oneLine: error.message,
      nextSteps: [],
    });
  });

  it("points a plugin component at the chat, where its approval is asked", () => {
    const error = stdioCommandApprovalRequired({
      serverId: "srv-1",
      serverDisplayName: "Files",
      spec: { command: "node", args: ["${PLUGIN_ROOT}/index.js"], env: {} },
      fingerprint: "ab".repeat(32),
      approval: "none",
      pluginComponent: true,
    });
    expect(error.message).toContain("Use it in a chat");
    expect(error.message).not.toContain("Servers");
  });

  it("omits cwd when the spec has none and marks a first approval", () => {
    const error = stdioCommandApprovalRequired({
      serverId: "srv-1",
      serverDisplayName: "Files",
      spec: { command: "node", args: [], env: {} },
      fingerprint: "ab".repeat(32),
      approval: "none",
    });
    const approval = (error.details as any).approval;
    expect(approval.previouslyApproved).toBe(false);
    expect("cwd" in approval).toBe(false);
    expect("changedEnvNames" in approval).toBe(false);
    expect(approval.envNames).toEqual([]);
  });
});
