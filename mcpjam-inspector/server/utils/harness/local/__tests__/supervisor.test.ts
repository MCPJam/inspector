import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  probeProcess,
  readProcessBirthIdentity,
  supportsOwnershipProof,
} from "../process-identity.js";
import { listProcessRecords } from "../process-registry.js";
import { LocalHarnessSupervisor, SupervisorError } from "../supervisor.js";

/** These exercise real processes, so they only run where the supervisor is
 *  willing to own one — which is the same predicate the manifest uses to
 *  decide whether a platform may offer native mode at all. */
const canOwnProcesses = supportsOwnershipProof();

let base: string;
let scripts: string;
let stateDir: string;
const realHome = process.env.HOME;

/** Poll until `pid` is gone, or give up. Returns whether it went. */
async function waitForExit(pid: number, timeoutMs = 8_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await readProcessBirthIdentity(pid)) === null) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

function supervisor(overrides = {}) {
  return new LocalHarnessSupervisor({
    limits: {
      maxWallClockMs: 30_000,
      maxOutputBytesPerStream: 1024 * 1024,
      maxConcurrentProcesses: 4,
      terminationGraceMs: 400,
      ...overrides,
    },
  });
}

function request(
  sessionId: string,
  script: string,
  role: "root" | "helper" = "root",
) {
  return {
    sessionId,
    executable: process.execPath,
    args: [join(scripts, script)],
    workingDirectory: base,
    env: { PATH: "/usr/bin:/bin", HOME: stateDir },
    runtimeId: "rt_test",
    workspaceGrantId: "ws_test",
    targetKind: "local-native" as const,
    sessionStateDir: stateDir,
    role,
  };
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mcpjam-supervisor-")));
  scripts = join(base, "scripts");
  // The registry writes under `homedir()`; point HOME at the temp tree so a
  // test never touches the developer's real state.
  process.env.HOME = base;
  stateDir = join(base, ".mcpjam", "harness-local", "sessions", "s1");
  await mkdir(scripts, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  await writeFile(
    join(scripts, "idle.js"),
    "console.log('ready');setInterval(()=>{},1000);",
  );
  await writeFile(
    join(scripts, "tree.js"),
    [
      "const { spawn } = require('node:child_process');",
      "const kid = spawn(process.execPath, ['-e', 'setInterval(function(){},1000)'], { stdio: 'ignore' });",
      "console.log(JSON.stringify({ grandchild: kid.pid }));",
      "setInterval(function(){}, 1000);",
    ].join("\n"),
  );
  await writeFile(
    join(scripts, "stubborn.js"),
    [
      "process.on('SIGTERM', function(){});",
      "process.on('SIGINT', function(){});",
      "console.log('ready');",
      "setInterval(function(){}, 1000);",
    ].join("\n"),
  );
  await writeFile(
    join(scripts, "flood.js"),
    [
      "const chunk = 'x'.repeat(64 * 1024);",
      "for (let i = 0; i < 200; i++) process.stdout.write(chunk);",
      // No process.exit(): it would discard the pending pipe writes and the
      // test would measure Node's exit behaviour rather than our cap.
    ].join("\n"),
  );
  // A root that exits promptly on SIGTERM while its child ignores it: the
  // case where "the root's pid is gone" is emphatically not "the tree is gone".
  await writeFile(
    join(scripts, "deserter.js"),
    [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e',",
      "  \"process.on('SIGTERM', function(){}); setInterval(()=>{},1000);\"],",
      "  { stdio: 'ignore' });",
      "console.log(child.pid);",
      "process.on('SIGTERM', function(){ process.exit(0); });",
      "setInterval(()=>{},1000);",
    ].join("\n"),
  );
  await writeFile(
    join(scripts, "natural-deserter.js"),
    [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e',",
      "  \"process.on('SIGTERM', function(){}); setInterval(()=>{},1000);\"],",
      "  { stdio: 'ignore' });",
      "console.log(child.pid);",
      // Give the supervisor time to persist the root record, then let the
      // leader disappear without a stop signal while its descendant remains.
      "setTimeout(function(){ process.exit(0); }, 250);",
    ].join("\n"),
  );
  await writeFile(
    join(scripts, "dump-env.js"),
    "process.stdout.write(JSON.stringify(process.env));",
  );
  await writeFile(
    join(scripts, "argv.js"),
    "process.stdout.write(JSON.stringify(process.argv.slice(2)));",
  );
});

afterAll(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
});

describe("launch preconditions", () => {
  it("refuses a bare executable name — there is no spawn-time PATH lookup", async () => {
    const sup = supervisor();
    await expect(
      sup.spawnSupervised({
        ...request("s-rel", "idle.js"),
        executable: "node",
      }),
    ).rejects.toThrow(/absolute, pre-verified paths only/);
  });

  it("refuses a relative working directory", async () => {
    const sup = supervisor();
    await expect(
      sup.spawnSupervised({
        ...request("s-cwd", "idle.js"),
        workingDirectory: "relative",
      }),
    ).rejects.toThrow(SupervisorError);
  });

  it("refuses argv carrying shell syntax", async () => {
    const sup = supervisor();
    await expect(
      sup.spawnSupervised({
        ...request("s-argv", "idle.js"),
        args: [join(scripts, "idle.js"), "; rm -rf /"],
      }),
    ).rejects.toThrow(/shell metacharacter/);
  });

  it("refuses a permission-bypass flag", async () => {
    const sup = supervisor();
    await expect(
      sup.spawnSupervised({
        ...request("s-bypass", "idle.js"),
        args: [join(scripts, "idle.js"), "--dangerously-skip-permissions"],
      }),
    ).rejects.toThrow(/disables the vendor permission controls/);
  });
});

describe("a root that exits while its tree does not", () => {
  it.skipIf(!canOwnProcesses)(
    "does not report stopped just because the ROOT is gone",
    async () => {
      // The root exits on SIGTERM; its child ignores it and stays in the same
      // process group. Reporting `graceful` on the root's own disappearance
      // would announce a stopped session over a live vendor process — so the
      // group is checked, escalated to SIGKILL, and confirmed.
      const sup = supervisor();
      const handle = await sup.spawnSupervised(
        request("s-desert", "deserter.js"),
      );
      const line = await new Promise<string>((resolve) => {
        const reader = handle.stdout.getReader();
        void reader.read().then(({ value }) => {
          resolve(new TextDecoder().decode(value ?? new Uint8Array()));
          reader.releaseLock();
        });
      });
      const deserter = Number(line.trim());
      expect(deserter).toBeGreaterThan(0);

      const result = await sup.stopSession("s-desert");
      expect(result).toEqual({ stopped: true, escaped: 0 });
      expect(await waitForExit(handle.pid)).toBe(true);
      expect(await waitForExit(deserter)).toBe(true);
    },
  );

  it.skipIf(!canOwnProcesses)(
    "retains ownership when the root exits naturally before stop",
    async () => {
      // The root here is gone before `stopSession` ever looks, so nothing in
      // the stop ties the surviving group to this tree: the id could have been
      // released and reissued at any point since the root exited, and an
      // unrelated leader that has since exited would leave a live group
      // wearing it. So the stop reports the survivor rather than SIGKILLing a
      // group it cannot prove is ours, and KEEPS the record, which is the only
      // durable handle on it. This test previously expected the sweep.
      //
      // Restoring the sweep soundly needs per-MEMBER identity, not a group
      // signal: enumerate the group once at the moment the root exits — while
      // its id provably still belongs to us — and record each member's pid and
      // birth identity, then at stop verify each with `isSameProcess` and
      // signal only those that still match. That is immune to pid reuse, but
      // it is a new platform primitive plus supervisor plumbing, deliberately
      // not folded in here.
      const sup = supervisor();
      const handle = await sup.spawnSupervised(
        request("s-natural-desert", "natural-deserter.js"),
      );
      const output = await new Response(handle.stdout).text();
      await expect(handle.wait()).resolves.toEqual({ exitCode: 0 });
      const descendant = Number(output.trim());
      expect(descendant).toBeGreaterThan(0);
      expect(await readProcessBirthIdentity(descendant)).not.toBeNull();

      // The leader is no longer live, but its ownership tombstone and durable
      // record remain until the whole group has been settled.
      expect(sup.liveProcessCount("s-natural-desert")).toBe(0);
      expect(
        (await listProcessRecords()).find(
          (record) => record.sessionId === "s-natural-desert",
        ),
      ).toBeDefined();

      await expect(sup.stopSession("s-natural-desert")).resolves.toEqual({
        stopped: false,
        escaped: 1,
      });
      // Not signalled, and still visible: an unswept survivor the operator can
      // still see beats a SIGKILL delivered to whoever now holds the id.
      expect((await probeProcess(descendant)).state).toBe("alive");
      expect(
        (await listProcessRecords()).find(
          (record) => record.sessionId === "s-natural-desert",
        ),
      ).toBeDefined();
      try {
        process.kill(descendant, "SIGKILL");
      } catch {
        /* already gone */
      }
    },
  );
});

describe("a stop that races a launch", () => {
  it.skipIf(!canOwnProcesses)(
    "refuses a launch that a stop landed in the middle of",
    async () => {
      // The regression: the supervisor's own identity read was hoisted above
      // the synchronous bucket reservation, so during that await `live` held
      // no bucket for the session — a concurrent `stopSession` saw nothing to
      // stop, reported `stopped: true`, and the launch went on to spawn a root
      // behind the stop.
      //
      // `spawnSupervised` runs synchronously up to its first await (the
      // identity read), so calling `stopSession` without awaiting the launch
      // puts the stop exactly in that window.
      const sup = supervisor();
      const launch = sup.spawnSupervised(request("s-stop-race", "idle.js"));
      const stop = sup.stopSession("s-stop-race");
      await expect(launch).rejects.toThrow(/was stopped while this launch/);
      await expect(stop).resolves.toEqual({ stopped: true, escaped: 0 });
    },
  );

  it.skipIf(!canOwnProcesses)(
    "still admits a launch that starts AFTER a stop has finished",
    async () => {
      // A stop is not a tombstone. The provider's own bridge retry depends on
      // this: a failed first spawn stops the session on its way out, and the
      // retry has to be admitted — and re-checked as a bridge — rather than
      // refused forever by the id it reused.
      const sup = supervisor();
      await sup.stopSession("s-stop-then-start");
      const handle = await sup.spawnSupervised(
        request("s-stop-then-start", "idle.js"),
      );
      expect(handle.pid).toBeGreaterThan(0);
      await sup.stopSession("s-stop-then-start");
      expect(await waitForExit(handle.pid)).toBe(true);
    },
  );

  it("still reports a stop honestly when nothing was running", async () => {
    const sup = supervisor();
    await expect(sup.stopSession("s-never-started")).resolves.toEqual({
      stopped: true,
      escaped: 0,
    });
  });
});

describe("a launch that fails at the OS", () => {
  it("rejects, and its late 'error' event does not take the Inspector down", async () => {
    // Node reports a missing executable two ways at once: `child.pid` is
    // undefined synchronously, AND an 'error' event fires later. The second
    // half is the dangerous one — an 'error' event with no listener is an
    // unhandled error event, which kills the whole process — and it arrives
    // AFTER this call has already thrown. The listener is attached
    // synchronously after spawn so that late event lands somewhere.
    const sup = supervisor();
    await expect(
      sup.spawnSupervised({
        ...request("s-enoent", "idle.js", "helper"),
        executable: join(scripts, "does-not-exist"),
      }),
    ).rejects.toThrow(SupervisorError);
    // Give the late 'error' event its turn. Reaching the next line at all is
    // the assertion: an unhandled one would have ended this process.
    await new Promise((r) => setTimeout(r, 100));
    expect(sup.liveProcessCount("s-enoent")).toBe(0);
  }, 20_000);
});

describe.skipIf(!canOwnProcesses)("supervised processes", () => {
  it("passes arguments structurally, with no shell in between", async () => {
    const sup = supervisor();
    const handle = await sup.spawnSupervised({
      ...request("s-structural", "argv.js", "helper"),
      args: [join(scripts, "argv.js"), "a b", "*.ts", "~", "--flag=value"],
    });
    const text = await new Response(handle.stdout).text();
    await handle.wait();
    // A shell would have split "a b", expanded "*.ts", and expanded "~".
    expect(JSON.parse(text)).toEqual(["a b", "*.ts", "~", "--flag=value"]);
  });

  it("hands the child only the environment it was given", async () => {
    const sup = supervisor();
    const handle = await sup.spawnSupervised({
      ...request("s-env", "dump-env.js", "helper"),
      env: { PATH: "/usr/bin:/bin", HOME: stateDir, LANG: "C" },
    });
    const text = await new Response(handle.stdout).text();
    await handle.wait();
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      [
        "HOME",
        "LANG",
        "PATH",
        // macOS injects this Core Foundation locale value into a child even
        // when Node receives an explicit, otherwise-empty environment.
        ...(process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []),
      ].sort(),
    );
  });

  it("records the root process with a birth identity before it runs", async () => {
    const sup = supervisor();
    const handle = await sup.spawnSupervised(request("s-record", "idle.js"));
    const records = await listProcessRecords();
    const record = records.find((r) => r.sessionId === "s-record");
    expect(record).toBeDefined();
    expect(record!.rootPid).toBe(handle.pid);
    expect(record!.processBirthIdentity).toBe(
      await readProcessBirthIdentity(handle.pid),
    );
    expect(record!.supervisorNonce).toBe(sup.nonce);
    await sup.stopSession("s-record");
  });

  it("kills descendants the child spawned, not just the child", async () => {
    const sup = supervisor();
    const handle = await sup.spawnSupervised(request("s-tree", "tree.js"));
    const line = await new Promise<string>((resolve) => {
      const reader = handle.stdout.getReader();
      void reader.read().then(({ value }) => {
        resolve(new TextDecoder().decode(value ?? new Uint8Array()));
        reader.releaseLock();
      });
    });
    const grandchild = JSON.parse(line.trim()).grandchild as number;
    expect(await readProcessBirthIdentity(grandchild)).not.toBeNull();

    const result = await sup.stopSession("s-tree");
    expect(result.stopped).toBe(true);
    expect(await waitForExit(handle.pid)).toBe(true);
    expect(await waitForExit(grandchild)).toBe(true);
  }, 20_000);

  it("force-kills a child that ignores SIGTERM", async () => {
    const sup = supervisor();
    const handle = await sup.spawnSupervised(
      request("s-stubborn", "stubborn.js"),
    );
    await new Promise((r) => setTimeout(r, 200));
    const result = await sup.stopSession("s-stubborn");
    expect(result.stopped).toBe(true);
    expect(result.escaped).toBe(0);
    expect(await waitForExit(handle.pid)).toBe(true);
  }, 20_000);

  it("clears the durable record once the tree is gone", async () => {
    const sup = supervisor();
    await sup.spawnSupervised(request("s-forget", "idle.js"));
    await sup.stopSession("s-forget");
    const records = await listProcessRecords();
    expect(records.find((r) => r.sessionId === "s-forget")).toBeUndefined();
  }, 20_000);

  it("stop is idempotent", async () => {
    const sup = supervisor();
    await sup.spawnSupervised(request("s-idem", "idle.js"));
    await expect(sup.stopSession("s-idem")).resolves.toMatchObject({
      stopped: true,
    });
    await expect(sup.stopSession("s-idem")).resolves.toMatchObject({
      stopped: true,
    });
  }, 20_000);

  it("caps retained output without blocking a flooding child", async () => {
    const sup = supervisor();
    const handle = await sup.spawnSupervised(
      request("s-flood", "flood.js", "helper"),
    );
    const text = await new Response(handle.stdout).text();
    const result = await handle.wait();
    // The child wrote ~12.8 MB; we retain 1 MB and keep draining, so it still
    // exits cleanly rather than blocking forever on a full pipe.
    expect(result.exitCode).toBe(0);
    expect(text.length).toBe(1024 * 1024);
  }, 20_000);

  it("kills the tree when the caller aborts", async () => {
    const sup = supervisor();
    const controller = new AbortController();
    const handle = await sup.spawnSupervised({
      ...request("s-abort", "idle.js"),
      abortSignal: controller.signal,
    });
    controller.abort();
    expect(await waitForExit(handle.pid)).toBe(true);
    await sup.stopSession("s-abort");
  }, 20_000);

  it("kills the tree at the wall-clock ceiling", async () => {
    const sup = supervisor({ maxWallClockMs: 500 });
    const handle = await sup.spawnSupervised(request("s-clock", "idle.js"));
    expect(await waitForExit(handle.pid)).toBe(true);
    await sup.stopSession("s-clock");
  }, 20_000);

  it("refuses to exceed the per-session process ceiling", async () => {
    const sup = supervisor({ maxConcurrentProcesses: 1 });
    await sup.spawnSupervised(request("s-cap", "idle.js"));
    await expect(
      sup.spawnSupervised(request("s-cap", "idle.js", "helper")),
    ).rejects.toThrow(/ceiling/);
    await sup.stopSession("s-cap");
  }, 20_000);
});

describe("platforms that cannot prove ownership", () => {
  it("refuses to start a root process there at all", async () => {
    const sup = new LocalHarnessSupervisor({ platform: "win32" });
    await expect(
      sup.spawnSupervised(request("s-win", "idle.js")),
    ).rejects.toThrow(/cannot prove ownership of a process tree/);
  });
});
