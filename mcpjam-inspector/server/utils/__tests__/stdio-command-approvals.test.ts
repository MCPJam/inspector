import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  approveStdioLaunch,
  createStdioCommandApprovalStore,
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
    await store.approve("srv-1", fingerprint);
    expect(await store.read("srv-1", fingerprint)).toBe("approved");
  });

  it("reports changed when the stored fingerprint differs", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    await store.approve("srv-1", stdioLaunchFingerprint(BASE));
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
    await store.approve("srv-1", first);
    await store.approve("srv-1", second);
    expect(await store.read("srv-1", second)).toBe("approved");
    expect(await store.read("srv-1", first)).toBe("changed");
  });

  it("keeps other servers' approvals when approving one", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    const fingerprint = stdioLaunchFingerprint(BASE);
    await store.approve("srv-1", fingerprint);
    await store.approve("srv-2", fingerprint);
    expect(await store.read("srv-1", fingerprint)).toBe("approved");
    expect(await store.read("srv-2", fingerprint)).toBe("approved");
  });

  it("treats an unreadable file as no approvals", async () => {
    const store = createStdioCommandApprovalStore(() => file);
    await store.approve("srv-1", stdioLaunchFingerprint(BASE));
    await writeFile(file, "{not json");
    expect(await store.read("srv-1", stdioLaunchFingerprint(BASE))).toBe(
      "none",
    );
  });

  it("writes the file readable by the owner only", async () => {
    if (process.platform === "win32") return;
    const store = createStdioCommandApprovalStore(() => file);
    await store.approve("srv-1", stdioLaunchFingerprint(BASE));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it("the default store follows MCPJAM_STDIO_APPROVALS_FILE", async () => {
    const custom = join(dir, "custom.json");
    vi.stubEnv("MCPJAM_STDIO_APPROVALS_FILE", custom);
    const fingerprint = stdioLaunchFingerprint(BASE);
    await approveStdioLaunch("srv-1", fingerprint);
    expect(await readStdioLaunchApproval("srv-1", fingerprint)).toBe(
      "approved",
    );
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
    });

    expect(error.status).toBe(403);
    expect(error.code).toBe("STDIO_COMMAND_APPROVAL_REQUIRED");
    expect(error.message).toContain('"Files"');
    expect(error.details).toEqual({
      reason: "stdio_command_approval_required",
      serverId: "srv-1",
      approval: {
        serverId: "srv-1",
        fingerprint,
        command: "node",
        args: ["server.js"],
        envNames: ["TOKEN"],
        cwd: "/srv",
        previouslyApproved: true,
      },
    });
    expect(JSON.stringify(error.details)).not.toContain("secret-value");
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
    expect(approval.envNames).toEqual([]);
  });
});
