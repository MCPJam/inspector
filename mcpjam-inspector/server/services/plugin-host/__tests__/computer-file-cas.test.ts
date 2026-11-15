// @vitest-environment node
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createComputerFileCas, qualifiedComputerFileCas, type ComputerCasTransport, type ComputerCompareAndReplaceInput } from "../computer-file-cas.js";
import { COMPUTER_FILE_CAS_COMMAND, COMPUTER_FILE_CAS_PYTHON } from "../computer-file-cas-helper.js";

const encode = (value: string) => new TextEncoder().encode(value);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
let home: string;
const children = new Set<ChildProcess>();
beforeEach(async () => { home = await realpath(await mkdtemp(join(tmpdir(), "computer-cas-"))); await mkdir(join(home, "parts")); });
afterEach(async () => { for (const child of children) child.kill("SIGKILL"); children.clear(); await rm(home, { recursive: true, force: true }); });

function transport(root = home) {
  const mapped = (path: string) => path === "/home/user" || path.startsWith("/home/user/") ? root + path.slice("/home/user".length) : path;
  const pids: number[] = [];
  const operations: string[] = [];
  let started!: () => void;
  const commitStarted = new Promise<void>(resolve => { started = resolve; });
  const value: ComputerCasTransport = {
    write: (path, bytes) => writeFile(mapped(path), Buffer.from(bytes)),
    run: (command, options) => new Promise((resolve, reject) => {
      expect(command).toBe(COMPUTER_FILE_CAS_COMMAND);
      const request = JSON.parse(Buffer.from(options.envs.MCPJAM_FILE_CAS, "base64url").toString());
      operations.push(request.op);
      if (request.root) request.root = mapped(request.root);
      if (request.path) request.path = mapped(request.path);
      // Only the VM's home prefix differs; both writers execute the production helper.
      const code = COMPUTER_FILE_CAS_PYTHON.replace('HOME = "/home/user"', `HOME = ${JSON.stringify(root)}`).replace('LOCK_ROOT = "/tmp/mcpjam-file-cas-" + str(os.getuid())', `LOCK_ROOT = ${JSON.stringify(join(root, ".cas-locks"))}`);
      const child = spawn("python3", ["-c", code], { env: { ...process.env, MCPJAM_FILE_CAS: Buffer.from(JSON.stringify(request)).toString("base64url") }, stdio: ["ignore", "pipe", "pipe"] });
      children.add(child);
      if (request.op === "commit") { pids.push(child.pid!); started(); }
      let stdout = "";
      child.stdout?.on("data", chunk => { stdout += chunk; });
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Helper timed out")); }, 5000);
      child.once("error", reject);
      child.once("exit", code => {
        clearTimeout(timer); children.delete(child);
        if (code === 0) resolve({ stdout }); else reject(new Error("Helper failed"));
      });
    }),
  };
  return { value, pids, operations, commitStarted };
}

async function holdLock(path: string) {
  await mkdir(join(home, ".cas-locks"), { mode: 0o700, recursive: true });
  const lock = join(home, ".cas-locks", digest(path));
  const child = spawn("python3", ["-c", "import fcntl,os,sys,time; f=os.open(sys.argv[1],os.O_RDWR|os.O_CREAT,0o600); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); time.sleep(30)", lock]);
  children.add(child);
  await new Promise<void>((resolve, reject) => { child.stdout!.once("data", () => resolve()); child.once("error", reject); });
  return child;
}

async function target(name = "part.stl", value = "original") {
  const path = join(home, "parts", name);
  await writeFile(path, value, { mode: 0o640 });
  return path;
}
function input(path: string, value = "changed", expected = "original"): ComputerCompareAndReplaceInput {
  return { root: join(home, "parts"), path, bytes: encode(value), expectedEtag: digest(expected), maxBytes: 64 };
}
async function stages(root = join(home, "parts")) {
  return (await readdir(root)).filter(name => name.startsWith(".mcpjam-cas-") && !name.startsWith(".mcpjam-cas-lock-"));
}

describe("Computer VM atomic file helper", () => {
  it("allows exactly one of two independent writer processes with the same ETag", async () => {
    const path = await target();
    const holder = await holdLock(path);
    const left = transport(), right = transport();
    const pending = Promise.all([
      createComputerFileCas(left.value).compareAndReplace(input(path, "left")),
      createComputerFileCas(right.value).compareAndReplace(input(path, "right")),
    ]);
    await Promise.all([left.commitStarted, right.commitStarted]);
    expect(await readFile(path, "utf8")).toBe("original");
    holder.kill("SIGKILL");
    const results = await pending;
    expect(results.map(value => value.outcome).sort()).toEqual(["conflict", "saved"]);
    expect(left.pids[0]).not.toBe(right.pids[0]);
    const content = await readFile(path, "utf8");
    expect(["left", "right"]).toContain(content);
    expect(results.every(value => value.etag === digest(content))).toBe(true);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    expect(await readdir(join(home, "parts"))).toEqual(["part.stl"]);
    expect(await stages()).toEqual([]);
  });

  it("does not let a cancelled waiter poison another caller's shared qualification", async () => {
    const t = transport();
    const original = t.value.run;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => { started = resolve; });
    t.value.run = async (command, options) => {
      const request = JSON.parse(Buffer.from(options.envs.MCPJAM_FILE_CAS!, "base64url").toString());
      if (request.op === "probe") {
        started(); await gate;
        options.signal?.throwIfAborted();
      }
      return original(command, options);
    };
    const cas = createComputerFileCas(t.value);
    const abort = new AbortController();
    const cancelled = cas.supports(abort.signal).then(() => "unexpected", () => "cancelled");
    await entered;
    const healthy = cas.supports();
    abort.abort(); resume();
    expect(await cancelled).toBe("cancelled");
    expect(await healthy).toBe(true);
    expect(t.operations.filter((op) => op === "probe")).toHaveLength(1);
  });

  it("does not share locks or results across independent Computer filesystems", async () => {
    const other = join(home, "other-vm"); await mkdir(join(other, "parts"), { recursive: true });
    const a = await target(); const b = join(other, "parts", "part.stl"); await writeFile(b, "original");
    const results = await Promise.all([
      createComputerFileCas(transport().value).compareAndReplace(input(a, "left")),
      createComputerFileCas(transport(other).value).compareAndReplace({ ...input(b, "right"), root: join(other, "parts") }),
    ]);
    expect(results.map(value => value.outcome)).toEqual(["saved", "saved"]);
    expect(await readFile(a, "utf8")).toBe("left"); expect(await readFile(b, "utf8")).toBe("right");
  });

  it("returns conflict without replacing a newer file and keeps a persistent lock inode", async () => {
    const path = await target(); const cas = createComputerFileCas(transport().value);
    await expect(cas.compareAndReplace(input(path, "first"))).resolves.toMatchObject({ outcome: "saved" });
    await mkdir(join(home, ".cas-locks"), { mode: 0o700, recursive: true });
  const lock = join(home, ".cas-locks", digest(path)); const before = await stat(lock);
    await expect(cas.compareAndReplace(input(path, "second"))).resolves.toEqual({ outcome: "conflict", etag: digest("first") });
    expect((await stat(lock)).ino).toBe(before.ino); expect(await readFile(path, "utf8")).toBe("first");
    expect(await stages()).toEqual([]);
  });

  it("refuses oversize data before staging and validates uploaded bytes", async () => {
    const path = await target(); const t = transport(); const cas = createComputerFileCas(t.value);
    await expect(cas.compareAndReplace({ ...input(path), maxBytes: 2 })).rejects.toMatchObject({ code: "RESOURCE_TOO_LARGE" });
    const original = t.value.write;
    t.value.write = async (path, bytes, options) => original(path, bytes.byteLength === 1 ? bytes : encode("corrupted").buffer, options);
    await expect(cas.compareAndReplace(input(path))).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    expect(await readFile(path, "utf8")).toBe("original"); expect(await stages()).toEqual([]);
  });

  it("rejects target and ancestor symlinks without touching their destinations", async () => {
    const outside = join(home, "outside"); await writeFile(outside, "protected");
    const path = join(home, "parts", "part.stl"); await symlink(outside, path);
    const cas = createComputerFileCas(transport().value);
    await expect(cas.compareAndReplace(input(path))).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    const linked = join(home, "linked"); await symlink(join(home, "parts"), linked);
    await expect(cas.compareAndReplace({ ...input(join(linked, "part.stl")), root: linked })).rejects.toMatchObject({ code: "RESOURCE_WRITE_UNAVAILABLE" });
    expect(await readFile(outside, "utf8")).toBe("protected");
  });

  it("treats shell syntax in an admitted filename as literal metadata", async () => {
    const path = await target("part'$(touch injected);.stl");
    await expect(createComputerFileCas(transport().value).compareAndReplace(input(path))).resolves.toMatchObject({ outcome: "saved" });
    expect(await readFile(path, "utf8")).toBe("changed");
    expect(await readdir(home)).not.toContain("injected");
  });

  it("does not remove a substituted staged file during cleanup", async () => {
    const path = await target(); const t = transport(); const write = t.value.write;
    t.value.write = async (path, data, options) => {
      await write(path, data, options);
      if (data.byteLength > 1) { await rename(path, path + ".original"); await writeFile(path, "another writer"); }
    };
    await expect(createComputerFileCas(t.value).compareAndReplace(input(path))).rejects.toMatchObject({ code: "RESOURCE_DENIED" });
    const [stage] = await stages(); expect(stage).toBeTruthy();
    expect(await readFile(join(home, "parts", stage!, "payload"), "utf8")).toBe("another writer");
    expect(await readFile(path, "utf8")).toBe("original");
  });

  it("keeps an unsupported helper read-only", async () => {
    const t = transport(); t.value.run = async () => { throw new Error("Python unavailable"); };
    const cas = createComputerFileCas(t.value);
    expect(await cas.supports()).toBe(false);
    await expect(cas.compareAndReplace(input(await target()))).rejects.toMatchObject({ code: "RESOURCE_WRITE_UNAVAILABLE" });
  });

  it("withdraws runtime write support after the helper becomes unavailable", async () => {
    const t = transport(); const cas = createComputerFileCas(t.value);
    expect(await cas.supports()).toBe(true);
    t.value.run = async () => { throw new Error("helper unavailable"); };
    await expect(cas.compareAndReplace(input(await target()))).rejects.toMatchObject({ code: "RESOURCE_WRITE_UNAVAILABLE" });
    expect(await cas.supports()).toBe(false);
  });

  it("releases the target lock when a separate holder process exits", async () => {
    const path = await target(); const holder = await holdLock(path);
    const t = transport(); const run = t.value.run;
    let started!: () => void; const commitStarted = new Promise<void>(resolve => { started = resolve; });
    t.value.run = (command, options) => {
      const pending = run(command, options);
      if (JSON.parse(Buffer.from(options.envs.MCPJAM_FILE_CAS, "base64url").toString()).op === "commit") started();
      return pending;
    };
    const pending = createComputerFileCas(t.value).compareAndReplace(input(path));
    await commitStarted;
    expect(await readFile(path, "utf8")).toBe("original");
    holder.kill("SIGKILL");
    await expect(pending).resolves.toMatchObject({ outcome: "saved" });
    expect(await stages()).toEqual([]);
  });

  it("never repeats a replacement after losing the helper acknowledgement", async () => {
    const path = await target(); const t = transport(); const run = t.value.run;
    t.value.run = async (command, options) => {
      const result = await run(command, options);
      if (JSON.parse(Buffer.from(options.envs.MCPJAM_FILE_CAS, "base64url").toString()).op === "commit") throw new Error("Lost acknowledgement");
      return result;
    };
    await expect(createComputerFileCas(t.value).compareAndReplace(input(path))).rejects.toMatchObject({ code: "RESOURCE_OUTCOME_UNKNOWN" });
    expect(await readFile(path, "utf8")).toBe("changed");
    expect(t.operations.filter(op => op === "commit")).toHaveLength(1);
    expect(await stages()).toEqual([]);
  });

  it("retains cleanup identity when cancelled during staging allocation", async () => {
    const path = await target(); const t = transport(); const cas = createComputerFileCas(t.value);
    expect(await cas.supports()).toBe(true);
    const controller = new AbortController(); const run = t.value.run;
    t.value.run = async (command, options) => {
      const request = JSON.parse(Buffer.from(options.envs.MCPJAM_FILE_CAS, "base64url").toString());
      const result = await run(command, options);
      if (request.op === "stage") { expect(options.signal).toBeUndefined(); controller.abort(); }
      return result;
    };
    await expect(cas.compareAndReplace(input(path), { signal: controller.signal })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("original");
    expect(await stages()).toEqual([]);
    expect(t.operations.filter(op => op === "commit")).toHaveLength(0);
  });

  it("cleans a cancelled upload and reports cancellation after replacement as unknown", async () => {
    const path = await target(); const before = new AbortController(); const t = transport(); const write = t.value.write;
    t.value.write = async (path, bytes, options) => { await write(path, bytes, options); if (bytes.byteLength > 1) before.abort(); };
    await expect(createComputerFileCas(t.value).compareAndReplace(input(path), { signal: before.signal })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("original"); expect(await stages()).toEqual([]);
    const after = new AbortController(); const next = transport(); const run = next.value.run;
    next.value.run = async (command, options) => {
      const result = await run(command, options);
      if (JSON.parse(Buffer.from(options.envs.MCPJAM_FILE_CAS, "base64url").toString()).op === "commit") after.abort();
      return result;
    };
    await expect(createComputerFileCas(next.value).compareAndReplace(input(path), { signal: after.signal })).rejects.toMatchObject({ code: "RESOURCE_OUTCOME_UNKNOWN" });
    expect(await readFile(path, "utf8")).toBe("changed"); expect(await stages()).toEqual([]);
    await expect(createComputerFileCas(transport().value).compareAndReplace(input(path, "next", "changed"))).resolves.toMatchObject({ outcome: "saved" });
  });
});

it("shares successful qualification across requests to one VM and retries transient failures", async () => {
  const id = randomUUID();
  const first = transport(); const second = transport();
  const cas = qualifiedComputerFileCas(id, first.value);
  expect(await cas.supports()).toBe(true);
  expect(await qualifiedComputerFileCas(id, second.value).supports()).toBe(true);
  expect(first.operations.filter(op => op === "probe")).toHaveLength(1);
  expect(second.operations).toEqual([]);
  const failed = transport();
  const run = failed.value.run;
  failed.value.run = async () => { throw new Error("temporary outage"); };
  const retry = qualifiedComputerFileCas(randomUUID(), failed.value);
  expect(await retry.supports()).toBe(false);
  failed.value.run = run;
  expect(await retry.supports()).toBe(true);
});
