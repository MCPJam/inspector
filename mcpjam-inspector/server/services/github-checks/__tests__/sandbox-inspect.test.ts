import { describe, expect, it } from "vitest";
import {
  listenerScript,
  parseListenerReport,
  readRepoFiles,
  readResolverInputs,
  LS_FILES_MAX_BYTES,
} from "../sandbox-inspect";
import type { CheckSandbox } from "../sandbox";

/**
 * A box whose command channel is scripted by predicate. Every read this module
 * performs is a `bash -lc` one-liner, so matching on the command text is the
 * honest way to fake it — and it is also what proves the CAP is applied inside
 * the box rather than after the transfer.
 */
function boxRunning(
  handler: (command: string) => { exitCode?: number; stdout?: string }
): { sandbox: CheckSandbox; commands: string[] } {
  const commands: string[] = [];
  const sandbox = {
    sandboxId: "sb_1",
    getHost: (port: number) => `${port}-sb_1.e2b.app`,
    commands: {
      run: async (command: string) => {
        commands.push(command);
        const result = handler(command);
        if (result.exitCode && result.exitCode !== 0) {
          // E2B throws on a non-zero exit; the module has to translate it back.
          throw Object.assign(new Error("non-zero exit"), result);
        }
        return { exitCode: 0, stdout: result.stdout ?? "", stderr: "" };
      },
    },
    kill: async () => {},
  } as unknown as CheckSandbox;
  return { sandbox, commands };
}

describe("readResolverInputs", () => {
  it("bounds every read IN the box, one byte past each documented cap", async () => {
    // `head -c`, never `cat` plus a slice here: a 200MB generated lockfile must
    // not cross the command channel at all. The extra byte is what lets an
    // OVER-cap file be told from one that merely fills it.
    const { sandbox, commands } = boxRunning(() => ({ stdout: "" }));
    await readResolverInputs(sandbox);

    const heads = commands.filter((c) => c.includes("head -c"));
    expect(heads.length).toBeGreaterThan(0);
    expect(commands.every((c) => !/\bcat\b/.test(c))).toBe(true);
    // package.json et al: DETECTION_MAX_BYTES (64KB) + 1.
    expect(commands.some((c) => c.includes("head -c 65537"))).toBe(true);
    // README.md: DETECTION_README_MAX_BYTES (256KB) + 1.
    expect(commands.some((c) => c.includes("head -c 262145"))).toBe(true);
    // mcpjam.yaml: MCPJAM_YAML_MAX_BYTES (32KB) + 1.
    expect(commands.some((c) => c.includes("head -c 32769"))).toBe(true);
  });

  it("reports a DETECTION file over its cap as absent — the detector ignores one either way", async () => {
    const oversize = "x".repeat(64 * 1024 + 1);
    const { sandbox } = boxRunning((command) =>
      command.includes("package.json") ? { stdout: oversize } : { exitCode: 42 }
    );
    const inputs = await readResolverInputs(sandbox);
    // Not a truncated prefix: half a package.json parses to something the
    // detector would then reason about as if it were the whole file.
    expect(inputs.detection.packageJson).toBeNull();
  });

  it("keeps a DETECTION file that exactly fills its cap", async () => {
    const exact = "x".repeat(64 * 1024);
    const { sandbox } = boxRunning((command) =>
      command.includes("package.json") ? { stdout: exact } : { exitCode: 42 }
    );
    const inputs = await readResolverInputs(sandbox);
    expect(inputs.detection.packageJson).toHaveLength(64 * 1024);
  });

  it("distinguishes an OVER-CAP mcpjam.yaml from an absent one", async () => {
    // The distinction the ladder depends on. `absent` means "this authoritative
    // rung does not apply, fall through to heuristics"; an over-cap declared
    // config is INVALID and must never be allowed to say that.
    const oversize = "x".repeat(32 * 1024 + 1);
    const { sandbox } = boxRunning((command) =>
      command.includes("mcpjam.yaml") ? { stdout: oversize } : { exitCode: 42 }
    );
    const inputs = await readResolverInputs(sandbox);
    expect(inputs.mcpjamYaml).toEqual({ kind: "over_cap" });
  });

  it("keeps an mcpjam.yaml that exactly fills its cap", async () => {
    const exact = "y".repeat(32 * 1024);
    const { sandbox } = boxRunning((command) =>
      command.includes("mcpjam.yaml") ? { stdout: exact } : { exitCode: 42 }
    );
    const inputs = await readResolverInputs(sandbox);
    expect(inputs.mcpjamYaml).toEqual({ kind: "present", text: exact });
  });

  it("treats a missing file as absent, not as an error", async () => {
    const { sandbox } = boxRunning(() => ({ exitCode: 42 }));
    const inputs = await readResolverInputs(sandbox);
    expect(inputs.mcpjamYaml).toEqual({ kind: "absent" });
    expect(inputs.detection.yarnLock).toBeNull();
  });

  it("reports an UNREADABLE mcpjam.yaml as absent, never as over-cap", async () => {
    // A read failure of ours must not fail somebody's PR, and it carries no
    // evidence that the file is oversized.
    const { sandbox } = boxRunning((command) =>
      command.includes("mcpjam.yaml") ? { exitCode: 1 } : { exitCode: 42 }
    );
    const inputs = await readResolverInputs(sandbox);
    expect(inputs.mcpjamYaml).toEqual({ kind: "absent" });
  });
});

describe("readRepoFiles", () => {
  it("uses `git ls-files -s -z` — the same contract the corpus harness parses", async () => {
    // `-s` is the load-bearing flag: it prints the MODE, which is the only thing
    // that separates a tracked `server.js` from a symlink into node_modules.
    const listing =
      "100644 abc 0\tsrc/index.js\u0000120000 def 0\tserver.js\u0000";
    const { sandbox, commands } = boxRunning(() => ({ stdout: listing }));
    const files = await readRepoFiles(sandbox);

    expect(commands[0]).toContain("ls-files -s -z");
    expect(files).toEqual([
      { path: "src/index.js", kind: "file" },
      { path: "server.js", kind: "symlink" },
    ]);
  });

  it("discards the trailing half-record when the byte cap bit", async () => {
    // A truncated path is not a shorter path, it is a DIFFERENT one: a
    // `src/index.jsx` cut to `src/index.js` would let rule C "verify" an entry
    // point that does not exist.
    const filler = "100644 abc 0\ta.js\u0000";
    const padding = "1".repeat(LS_FILES_MAX_BYTES - filler.length - 20);
    const stdout = `${filler}100644 abc 0\tsrc/index.js${padding}`;
    const { sandbox } = boxRunning(() => ({ stdout }));
    const files = await readRepoFiles(sandbox);
    expect(files).toEqual([{ path: "a.js", kind: "file" }]);
  });

  it("returns an empty listing when git fails — a valid input, not an error", async () => {
    const { sandbox } = boxRunning(() => ({ exitCode: 128 }));
    expect(await readRepoFiles(sandbox)).toEqual([]);
  });
});

describe("listenerScript", () => {
  it("computes nothing at runtime: no `$`, no backticks", () => {
    // The script is handed to the box inside a double-quoted shell string. A `$`
    // or a backtick in it would be expanded by that shell and rewrite our
    // diagnostic before node ever sees it.
    const script = listenerScript(3001);
    expect(script).not.toContain("$");
    expect(script).not.toContain("`");
    expect(script).toContain("const PORT=3001;");
    expect(script).toContain("/proc/net/tcp");
  });

  it("refuses a port that is not a port", () => {
    expect(() => listenerScript(3001.5)).toThrow();
    expect(() => listenerScript(99999)).toThrow();
    expect(() => listenerScript(0)).toThrow();
  });

  it("tells the box NOTHING about who we expect, and reads no argv", () => {
    // Two properties, both about where the comparison happens. The script is
    // handed no expected pid, so nothing in the box can tailor its answer to
    // it; and it never reads `cmdline`, so no argv a PR chose can influence the
    // verdict. Identity comes from the spawn and is compared on our side.
    const script = listenerScript(3001);
    expect(script).not.toContain("EXPECT");
    expect(script).not.toContain("cmdline");
    expect(script).not.toContain("realpath");
  });
});

describe("parseListenerReport", () => {
  it("reads the marker line out of surrounding noise", () => {
    const report = parseListenerReport(
      [
        "some warning from the runtime",
        `MCPJAM_CHECK_LISTENER ${JSON.stringify({
          processes: [{ pid: 9, ppids: [4], pgrp: 4 }],
        })}`,
      ].join("\n")
    );
    expect(report?.processes).toEqual([{ pid: 9, ppids: [4], pgrp: 4 }]);
  });

  it("returns null — 'could not tell' — for anything unreadable", () => {
    // The caller owns that as `infra_error`. It must never read as a pass.
    expect(parseListenerReport("")).toBeNull();
    expect(parseListenerReport("MCPJAM_CHECK_LISTENER {not json")).toBeNull();
    expect(parseListenerReport("node: command not found")).toBeNull();
  });
});
