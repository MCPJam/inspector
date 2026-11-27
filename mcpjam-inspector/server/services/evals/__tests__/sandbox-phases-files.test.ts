import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { Header } from "tar";
import type { PhaseSandbox } from "../sandbox-phases/exec.js";
import {
  admittedPath,
  collectGradingFiles,
  MAX_GRADING_FILE_ENTRIES,
  MAX_GRADING_FILES_BYTES,
  parseGradingArchive,
  restoreGradingFiles,
  type GradingFileEntry,
} from "../sandbox-phases/grading-files.js";
import { iterationPhaseContext } from "../sandbox-phases/iteration-hooks.js";
import { gradeIteration } from "../sandbox-phases/iteration-phases.js";
import type { PhaseBoxDeps } from "../sandbox-phases/phase-box.js";

// EFTW-90 (E7, P6, P7): declared files come off the agent's box as hostile
// input and reach the grading box as plain files owned by the box user.

/** One raw tar entry, as a box's own `tar` (or an attacker) could write it. */
function tarEntry(
  path: string,
  type: string,
  opts: { data?: string | Buffer; mode?: number; linkpath?: string } = {},
): Buffer {
  const body =
    typeof opts.data === "string" ? Buffer.from(opts.data) : opts.data;
  const size = type === "File" ? (body?.length ?? 0) : 0;
  const header = new Header({
    path,
    type,
    size,
    mode: opts.mode ?? (type === "Directory" ? 0o755 : 0o644),
    mtime: new Date(0),
    uid: 1000,
    gid: 1000,
    ...(opts.linkpath ? { linkpath: opts.linkpath } : {}),
  });
  header.encode();
  if (!size || !body) return header.block!;
  const pad = Buffer.alloc((512 - (size % 512)) % 512);
  return Buffer.concat([header.block!, body, pad]);
}

function archive(...entries: Buffer[]): Uint8Array {
  return new Uint8Array(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

const ROOTS = ["home/user/app"];

describe("which archive entries are copied", () => {
  it("admits relative paths inside a declared path only", () => {
    expect(admittedPath("home/user/app", ROOTS)).toBe("home/user/app");
    expect(admittedPath("./home/user/app/out/", ROOTS)).toBe(
      "home/user/app/out",
    );
    for (const refused of [
      "home/user/apple",
      "home/user/other.txt",
      "/home/user/app/x",
      "home/user/app/../../etc/passwd",
      "home/user/app//x",
      "home/user/app/./x",
      "",
    ]) {
      expect(admittedPath(refused, ROOTS)).toBeUndefined();
    }
  });

  it("keeps regular files and directories; drops links, devices and strays", async () => {
    const parsed = await parseGradingArchive(
      archive(
        tarEntry("home/user/app/", "Directory"),
        tarEntry("home/user/app/report.json", "File", { data: '{"ok":1}' }),
        tarEntry("home/user/app/run.sh", "File", {
          data: "echo hi",
          mode: 0o4755,
        }),
        tarEntry("home/user/app/link", "SymbolicLink", {
          linkpath: "/mcpjam/iteration.json",
        }),
        tarEntry("home/user/app/hard", "Link", {
          linkpath: "home/user/app/report.json",
        }),
        tarEntry("home/user/app/tty", "CharacterDevice"),
        tarEntry("home/user/other.txt", "File", { data: "stray" }),
        tarEntry("home/user/app/../../../etc/cron.d/x", "File", {
          data: "* * * * * root sh",
        }),
      ),
      ROOTS,
    );
    expect(parsed).toEqual({
      ok: true,
      bytes: 15,
      entries: [
        { type: "directory", path: "home/user/app" },
        {
          type: "file",
          path: "home/user/app/report.json",
          executable: false,
          data: new Uint8Array(Buffer.from('{"ok":1}')),
        },
        {
          type: "file",
          path: "home/user/app/run.sh",
          executable: true,
          data: new Uint8Array(Buffer.from("echo hi")),
        },
      ],
    });
  });

  it("reads an archive of zero blocks as no files: none of the paths existed", async () => {
    for (const empty of [new Uint8Array(10_240), new Uint8Array(0)]) {
      expect(await parseGradingArchive(empty, ROOTS)).toEqual({
        ok: true,
        entries: [],
        bytes: 0,
      });
    }
  });

  it("refuses more than 25 MB of content or too many entries", async () => {
    const big = await parseGradingArchive(
      archive(
        tarEntry("home/user/app/big.bin", "File", {
          data: Buffer.alloc(MAX_GRADING_FILES_BYTES + 1),
        }),
      ),
      ROOTS,
    );
    expect(big).toEqual({
      ok: false,
      problem: "The files declared for grading are over 25 MB together.",
    });
    const many = await parseGradingArchive(
      archive(
        ...Array.from({ length: MAX_GRADING_FILE_ENTRIES + 1 }, (_, i) =>
          tarEntry(`home/user/app/d${i}/`, "Directory"),
        ),
      ),
      ROOTS,
    );
    expect(many).toMatchObject({ ok: false });
  });

  it("stops at the cap without reading the rest of the archive", async () => {
    // Malformed after the over-cap file: reading on would fail there and
    // report that instead of the cap.
    const parsed = await parseGradingArchive(
      new Uint8Array(
        Buffer.concat([
          tarEntry("home/user/app/big.bin", "File", {
            data: Buffer.alloc(MAX_GRADING_FILES_BYTES + 1),
          }),
          Buffer.alloc(512, 0x41),
          Buffer.alloc(1024),
        ]),
      ),
      ROOTS,
    );
    expect(parsed).toEqual({
      ok: false,
      problem: "The files declared for grading are over 25 MB together.",
    });
  });

  it("refuses a compressed archive unread, whatever it would inflate to", async () => {
    // A replaced `tar` can hand back a gzip or zstd bomb, which the parser
    // would inflate on its own.
    const refused = {
      ok: false,
      problem:
        "The declared files couldn't be read: the agent's box returned a compressed archive, and only a plain tar is accepted.",
    };
    const gzipped = gzipSync(
      archive(
        tarEntry("home/user/app/zeros.bin", "File", {
          data: Buffer.alloc(4 * 1024 * 1024),
        }),
      ),
    );
    expect(await parseGradingArchive(new Uint8Array(gzipped), ROOTS)).toEqual(
      refused,
    );
    const zstdMagic = Buffer.concat([
      Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
      Buffer.alloc(1020),
    ]);
    expect(await parseGradingArchive(new Uint8Array(zstdMagic), ROOTS)).toEqual(
      refused,
    );
  });
});

describe("collecting from the agent's box", () => {
  function agentBox(stream: ReadableStream<Uint8Array>) {
    const run = vi.fn(async () => ({ exitCode: 0 }));
    const read = vi.fn(async () => stream);
    return {
      run,
      read,
      box: { commands: { run }, files: { read } } as unknown as PhaseSandbox,
    };
  }

  it("packs the declared paths, quoted, without following links", async () => {
    const agent = agentBox(
      streamOf(
        archive(tarEntry("home/user/app/a.txt", "File", { data: "hello" })),
      ),
    );
    const collected = await collectGradingFiles(
      agent.box,
      ["/home/user/app/", "/home/user/it's here"],
      { timeoutMs: 1000 },
    );
    expect(collected).toMatchObject({
      ok: true,
      bytes: 5,
      entries: [{ type: "file", path: "home/user/app/a.txt" }],
    });
    const [command, runOpts] = agent.run.mock.calls[0] as unknown as [
      string,
      { retainOutput?: boolean },
    ];
    expect(command).toContain(`'home/user/app' 'home/user/it'\\''s here'`);
    expect(command).toContain("--files-from=");
    expect(command).not.toMatch(/ -h | --dereference/);
    // A fresh, unguessable directory: no planted link at the archive path.
    const dir = /mkdir (\/tmp\/mcpjam-files-[0-9a-f-]{36}) /.exec(command)?.[1];
    expect(dir).toBeDefined();
    expect(command).not.toContain("mkdir -p");
    // Nothing the box prints is kept.
    expect(runOpts.retainOutput).toBe(false);
    expect(agent.read).toHaveBeenCalledWith(
      `${dir}/files.tar`,
      expect.objectContaining({ format: "stream" }),
    );
  });

  it("stops reading an archive past the cap, whatever the box claims", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const agent = agentBox(
      streamOf(...Array.from({ length: 40 }, () => chunk)),
    );
    expect(
      await collectGradingFiles(agent.box, ["/home/user/app"], {
        timeoutMs: 1000,
      }),
    ).toEqual({
      ok: false,
      problem: "The files declared for grading are over 25 MB together.",
    });
  });

  it("reports a box that couldn't pack them", async () => {
    const run = vi.fn(async () => {
      throw new Error("tar: fatal");
    });
    const box = { commands: { run }, files: {} } as unknown as PhaseSandbox;
    expect(
      await collectGradingFiles(box, ["/home/user/app"], { timeoutMs: 1000 }),
    ).toEqual({
      ok: false,
      problem:
        "The declared files couldn't be copied from the agent's box: tar: fatal",
    });
  });
});

/** A grading box that records every write and command, in order. */
function recordingBox() {
  const log: string[] = [];
  const written = new Map<string, unknown>();
  const box = {
    files: {
      write: vi.fn(async (pathOrEntries: unknown, data?: unknown) => {
        const entries = Array.isArray(pathOrEntries)
          ? (pathOrEntries as Array<{ path: string; data: unknown }>)
          : [{ path: pathOrEntries as string, data }];
        for (const entry of entries) {
          log.push(`write ${entry.path}`);
          written.set(entry.path, entry.data);
        }
        return entries.map((e) => ({ path: e.path }));
      }),
      read: vi.fn(async () => {
        throw new Error("not found");
      }),
    },
    commands: {
      run: vi.fn(async (cmd: string, opts?: { background?: boolean }) => {
        log.push(`run ${cmd}`);
        if (!opts?.background) return { exitCode: 0 };
        return { kill: async () => true, wait: async () => ({ exitCode: 0 }) };
      }),
    },
  };
  return { box: box as unknown as PhaseSandbox, log, written };
}

describe("restoring into the grading box", () => {
  it("writes files at their original paths as the box user, executables 0755", async () => {
    const grading = recordingBox();
    const entries: GradingFileEntry[] = [
      { type: "directory", path: "home/user/app/empty" },
      {
        type: "file",
        path: "home/user/app/run.sh",
        executable: true,
        data: new Uint8Array(Buffer.from("echo hi")),
      },
      {
        type: "file",
        path: "home/user/app/out.json",
        executable: false,
        data: new Uint8Array(Buffer.from("{}")),
      },
    ];
    await restoreGradingFiles(grading.box, entries);
    expect(grading.written.get("/tmp/mcpjam/grading-dirs.list")).toBe(
      "/home/user/app/empty\0",
    );
    expect(grading.written.get("/tmp/mcpjam/grading-exec.list")).toBe(
      "/home/user/app/run.sh\0",
    );
    expect(grading.written.get("/home/user/app/out.json")).toEqual(
      new Uint8Array(Buffer.from("{}")),
    );
    const commands = grading.log.filter((line) => line.startsWith("run "));
    expect(commands).toEqual([
      "run xargs -0 -r mkdir -p -- < /tmp/mcpjam/grading-dirs.list",
      "run xargs -0 -r chmod 0755 -- < /tmp/mcpjam/grading-exec.list",
    ]);
    // Nothing runs as root.
    for (const call of (grading.box.commands.run as ReturnType<typeof vi.fn>)
      .mock.calls) {
      expect((call[1] as { user?: string } | undefined)?.user).toBeUndefined();
    }
  });
});

describe("grading with declared files", () => {
  const evaluator = {
    id: "report",
    fileName: "report.sh",
    script: "test -f /home/user/app/out.json",
    role: "advisory" as const,
  };
  const input = {
    version: 1 as const,
    scenario: { title: "Case" },
    transcript: { toolCalls: [] },
    trace: { messages: [] },
  };

  function context(box: PhaseSandbox | undefined) {
    const provisioned: string[] = [];
    const deps: PhaseBoxDeps = {
      provision: (async () => {
        provisioned.push("grading");
        return { ok: true, value: { sandboxId: "sbx", sandboxRowId: "row" } };
      }) as unknown as PhaseBoxDeps["provision"],
      attach: async () => box!,
      release: async () => {},
    };
    return {
      provisioned,
      ctx: {
        ...iterationPhaseContext({
          config: {
            codeEvaluators: [evaluator],
            scripts: {},
            grading: { files: ["/home/user/app"] },
          },
          runId: "run",
          iterationId: "it",
          bearer: () => "token",
          deadlineAt: Date.now() + 60_000,
        })!,
        deps,
      },
    };
  }

  it("restores the files before the grader's own input exists", async () => {
    const grading = recordingBox();
    const { ctx } = context(grading.box);
    await gradeIteration(ctx, input, {
      ok: true,
      bytes: 2,
      entries: [
        {
          type: "file",
          path: "home/user/app/out.json",
          executable: false,
          data: new Uint8Array(Buffer.from("{}")),
        },
      ],
    });
    const restored = grading.log.indexOf("write /home/user/app/out.json");
    const prepared = grading.log.findIndex((l) =>
      l.includes("mkdir -p /mcpjam"),
    );
    expect(restored).toBeGreaterThanOrEqual(0);
    expect(restored).toBeLessThan(prepared);
  });

  it("errors every evaluator, and boots nothing, when the files couldn't be copied", async () => {
    const { ctx, provisioned } = context(undefined);
    const result = await gradeIteration(ctx, input, {
      ok: false,
      problem: "The files declared for grading are over 25 MB together.",
    });
    expect(provisioned).toEqual([]);
    expect(result.outcomes.report).toEqual({
      kind: "error",
      error: "The files declared for grading are over 25 MB together.",
      output: "",
    });
  });
});
