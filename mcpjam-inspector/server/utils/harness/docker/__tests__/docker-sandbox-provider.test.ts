import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { spawn as nodeSpawn } from "node:child_process";
import { createDockerHarnessSandboxProvider } from "../docker-sandbox-provider.js";
import { harnessPnpmGuardCommand } from "../../harness-bake.js";

// The docker CLI is faked at the `spawn` seam: these tests are about how the
// provider maps the sandbox contract onto `docker exec` (users, env handling,
// exit codes, process-group kill), not about Docker. The end-to-end proof
// against a real container is `hosted-harness-docker.e2e.test.ts`.

type Call = {
  args: string[];
  env: NodeJS.ProcessEnv;
  stdin: string;
  child: FakeChild;
};
type Reply = {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  hold?: boolean;
};

class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((signal?: NodeJS.Signals) => {
    if (this.exitCode !== null || this.signalCode !== null) return true;
    this.signalCode = signal ?? "SIGTERM";
    this.finish(null, this.signalCode);
    return true;
  });
  finish(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit("close", code, signal));
  }
}

function fakeDocker(reply: (args: string[]) => Reply) {
  const calls: Call[] = [];
  const spawnProcess = ((
    _bin: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv },
  ) => {
    const child = new FakeChild();
    const call: Call = { args, env: options.env, stdin: "", child };
    calls.push(call);
    child.stdin.on("data", (chunk) => (call.stdin += chunk.toString()));
    setImmediate(() => {
      child.emit("spawn");
      const r = reply(args);
      if (r.stdout) child.stdout.write(r.stdout);
      if (r.stderr) child.stderr.write(r.stderr);
      if (!r.hold) {
        // Give stdin a chance to drain before "exiting".
        setImmediate(() => child.finish(r.exitCode ?? 0));
      }
    });
    return child;
  }) as unknown as typeof nodeSpawn;
  return { calls, spawnProcess };
}

const STATE_FORMAT = "{{.State.Running}} {{.HostConfig.NetworkMode}}";

/** Default container behaviour: running on the host network, pnpm present. */
function baseReply(args: string[]): Reply | undefined {
  if (args[0] === "inspect" && args.includes(STATE_FORMAT)) {
    return { stdout: "true host\n" };
  }
  if (
    args.includes(
      harnessPnpmGuardCommand(),
    )
  ) {
    return { stdout: "/usr/local/bin/pnpm\n" };
  }
  return undefined;
}

const scriptOf = (args: string[]) => args[args.indexOf("-c") + 1] ?? "";

async function session(
  reply: (args: string[]) => Reply = () => ({}),
  extra: Partial<Parameters<typeof createDockerHarnessSandboxProvider>[0]> = {},
) {
  const docker = fakeDocker((args) => baseReply(args) ?? reply(args));
  const provider = createDockerHarnessSandboxProvider({
    containerId: "harness-ci",
    spawnProcess: docker.spawnProcess,
    ...extra,
  });
  const s = await provider.createSession();
  return { s, calls: docker.calls, provider };
}

describe("attaching", () => {
  it("attaches to a running container and runs the PINNED pnpm guard as the runtime user", async () => {
    const { s, calls } = await session();
    expect(s.id).toBe("harness-ci");
    expect(s.defaultWorkingDirectory).toBe("/home/user");
    expect(calls[0]!.args).toEqual([
      "inspect",
      "-f",
      STATE_FORMAT,
      "harness-ci",
    ]);
    expect(calls[1]!.args).toEqual([
      "exec",
      "-u",
      "user",
      "-w",
      "/home/user",
      "harness-ci",
      "bash",
      "-c",
      harnessPnpmGuardCommand(),
    ]);
  });

  it("refuses a container that is not running, rather than starting one", async () => {
    const docker = fakeDocker((args) =>
      args[0] === "inspect" ? { stdout: "false host\n" } : {},
    );
    const provider = createDockerHarnessSandboxProvider({
      containerId: "stopped",
      spawnProcess: docker.spawnProcess,
    });
    await expect(provider.createSession()).rejects.toThrow(
      /stopped is not running/,
    );
    expect(
      docker.calls.some((c) => c.args[0] === "start" || c.args[0] === "run"),
    ).toBe(false);
  });

  it("says so when pnpm is missing and cannot be installed", async () => {
    const docker = fakeDocker((args) =>
      args[0] === "inspect"
        ? { stdout: "true host\n" }
        : { exitCode: 1, stderr: "npm error code ECONNRESET" },
    );
    const provider = createDockerHarnessSandboxProvider({
      containerId: "c",
      spawnProcess: docker.spawnProcess,
    });
    await expect(provider.createSession()).rejects.toThrow(
      /pnpm is missing.*ECONNRESET/s,
    );
  });
});

describe("file I/O", () => {
  it("reads as the runtime user and maps a missing file to null", async () => {
    const { s, calls } = await session((args) => {
      const path = args[args.length - 1];
      if (path === "/home/user/missing") return { exitCode: 44 };
      if (path === "/home/user/secret")
        return { exitCode: 1, stderr: "cat: Permission denied" };
      return { stdout: "hello\n" };
    });
    await expect(s.readTextFile({ path: "/home/user/a.txt" })).resolves.toBe(
      "hello\n",
    );
    await expect(
      s.readTextFile({ path: "/home/user/missing" }),
    ).resolves.toBeNull();
    await expect(
      s.readBinaryFile({ path: "/home/user/missing" }),
    ).resolves.toBeNull();
    // A real failure is not "absent": it must surface.
    await expect(s.readTextFile({ path: "/home/user/secret" })).rejects.toThrow(
      /Permission denied/,
    );
    const read = calls.find((c) => c.args.at(-1) === "/home/user/a.txt")!;
    expect(read.args.slice(0, 4)).toEqual(["exec", "-u", "user", "harness-ci"]);
  });

  it("writes through stdin, creating parent directories like E2B does", async () => {
    const { s, calls } = await session();
    await s.writeTextFile({
      path: "/home/user/.harness-bootstrap/x/package.json",
      content: '{"a":1}',
    });
    const write = calls.at(-1)!;
    expect(write.args).toContain("-i");
    expect(scriptOf(write.args)).toContain("mkdir -p");
    expect(write.args.at(-1)).toBe(
      "/home/user/.harness-bootstrap/x/package.json",
    );
    expect(write.stdin).toBe('{"a":1}');
  });

  it("throws when a write fails", async () => {
    const { s } = await session((args) =>
      args.includes("-i")
        ? { exitCode: 1, stderr: "read-only file system" }
        : {},
    );
    await expect(
      s.writeBinaryFile({ path: "/etc/x", content: new Uint8Array([1, 2]) }),
    ).rejects.toThrow(/read-only file system/);
  });
});

describe("run", () => {
  it("runs bash as the user in the working directory, with env values off the argv", async () => {
    const onSessionEnvUsed = vi.fn();
    const { s, calls } = await session(
      () => ({ exitCode: 3, stdout: "out", stderr: "err" }),
      {
        sessionEnv: { STRIPE_API_KEY: "sk_test_x", SHARED: "session" },
        onSessionEnvUsed,
      },
    );
    const result = await s.run({
      command: "echo hi",
      workingDirectory: "/home/user/work",
      env: { SHARED: "command", DOCKER_HOST_LIKE: "1", DOCKER_X: "inline" },
    });
    // A non-zero exit is a RESULT, not a rejection — the contract E2B maps too.
    expect(result).toEqual({ exitCode: 3, stdout: "out", stderr: "err" });
    const call = calls.at(-1)!;
    expect(call.args.slice(0, 5)).toEqual([
      "exec",
      "-u",
      "user",
      "-w",
      "/home/user/work",
    ]);
    expect(call.args.slice(-3)).toEqual(["bash", "-c", "echo hi"]);
    // The secret is NOT in argv; docker copies it from the client's env.
    expect(call.args.join(" ")).not.toContain("sk_test_x");
    expect(call.args).toContain("STRIPE_API_KEY");
    expect(call.env.STRIPE_API_KEY).toBe("sk_test_x");
    // The command's own env wins over the ambient session bag.
    expect(call.env.SHARED).toBe("command");
    // `DOCKER_*` would steer the docker client itself, so it goes inline.
    expect(call.args).toContain("DOCKER_X=inline");
    expect(call.env.DOCKER_X).toBeUndefined();
    expect(onSessionEnvUsed).toHaveBeenCalledTimes(1);
    await s.run({ command: "true" });
    expect(onSessionEnvUsed).toHaveBeenCalledTimes(1);
  });

  it("does not stamp env delivery when the command never ran", async () => {
    const onSessionEnvUsed = vi.fn();
    const { s } = await session(() => ({}), {
      sessionEnv: { K: "v" },
      onSessionEnvUsed,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      s.run({ command: "true", abortSignal: controller.signal }),
    ).rejects.toThrow();
    expect(onSessionEnvUsed).not.toHaveBeenCalled();
  });
});

describe("spawn", () => {
  it("runs the command in its own process group and kills the whole group inside the container", async () => {
    let pidFile = "";
    const { s, calls } = await session((args) => {
      if (args.includes("setsid")) {
        pidFile = args[args.length - 2]!;
        return { stdout: "bridge listening\n", hold: true };
      }
      return {};
    });
    const proc = await s.spawn({
      command: "node bridge.mjs",
      workingDirectory: "/home/user",
    });
    const spawnCall = calls.find((c) => c.args.includes("setsid"))!;
    expect(spawnCall.args).toEqual(
      expect.arrayContaining(["setsid", "-w", "sh", "-c"]),
    );
    expect(spawnCall.args.at(-1)).toBe("node bridge.mjs");
    expect(pidFile).toMatch(/^\/tmp\/\.mcpjam-docker-spawn-[0-9a-f-]+\.pid$/);

    const reader = proc.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("bridge listening\n");

    await proc.kill();
    // The group kill ran INSIDE the container, as the user, against the
    // recorded group id — killing the docker client alone leaves it running.
    const killCall = calls.find((c) =>
      scriptOf(c.args).includes('kill -TERM -- "-$p"'),
    )!;
    expect(killCall.args.slice(0, 4)).toEqual([
      "exec",
      "-u",
      "user",
      "harness-ci",
    ]);
    expect(killCall.args.at(-1)).toBe(pidFile);
    expect(spawnCall.child.kill).toHaveBeenCalled();
    await expect(proc.wait()).resolves.toEqual({ exitCode: 137 });
    // Streams end, so a reader to EOF never hangs.
    expect((await reader.read()).done).toBe(true);
  });

  it("reports the command's own exit code when it ends by itself", async () => {
    const { s } = await session((args) =>
      args.includes("setsid") ? { exitCode: 7 } : {},
    );
    const proc = await s.spawn({ command: "exit 7" });
    await expect(proc.wait()).resolves.toEqual({ exitCode: 7 });
  });

  it("kills the group when the caller aborts", async () => {
    const { s, calls } = await session((args) =>
      args.includes("setsid") ? { hold: true } : {},
    );
    const controller = new AbortController();
    const proc = await s.spawn({
      command: "sleep 60",
      abortSignal: controller.signal,
    });
    controller.abort();
    await proc.wait();
    expect(calls.some((c) => scriptOf(c.args).includes("kill -TERM"))).toBe(
      true,
    );
  });
});

describe("infra surface", () => {
  it("resolves the bridge over loopback when the container shares the host network", async () => {
    const { s } = await session();
    expect(s.ports).toEqual([39271]);
    await expect(
      s.getPortEndpoint({ port: 39271, protocol: "ws" }),
    ).resolves.toEqual({
      url: "ws://127.0.0.1:39271",
    });
    await expect(s.getPortUrl({ port: 39271 })).resolves.toBe(
      "http://127.0.0.1:39271",
    );
  });

  it("refuses a container that is not on the host network, whose bridge loopback cannot reach", async () => {
    const docker = fakeDocker((args) =>
      args[0] === "inspect" && args.includes(STATE_FORMAT)
        ? { stdout: "true bridge\n" }
        : (baseReply(args) ?? {}),
    );
    await expect(
      createDockerHarnessSandboxProvider({
        containerId: "harness-ci",
        spawnProcess: docker.spawnProcess,
      }).createSession(),
    ).rejects.toThrow(
      /runs on the "bridge" network; start it with `--network host`/,
    );
    // Refused before anything ran in it.
    expect(docker.calls.some((c) => c.args[0] === "exec")).toBe(false);
  });

  it("never stops or removes the container, and hands tools a narrowed view", async () => {
    const { s, calls } = await session();
    const before = calls.length;
    await s.stop();
    await s.destroy();
    expect(calls.length).toBe(before);
    const restricted = s.restricted() as Record<string, unknown>;
    expect(restricted.stop).toBeUndefined();
    expect(restricted.getPortEndpoint).toBeUndefined();
    expect(typeof restricted.run).toBe("function");
    expect(Object.isFrozen(restricted)).toBe(true);
  });

  it("resumes by attaching again", async () => {
    const { provider } = await session();
    await expect(
      provider.resumeSession!({ sessionId: "anything" }),
    ).resolves.toMatchObject({ id: "harness-ci" });
  });
});
