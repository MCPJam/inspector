/**
 * The candidate's STARTUP PROBE: can this build's Inspector layer start on a
 * freshly verified pack, before anything selects it?
 *
 * Verification proves the bytes are the ones we published. It cannot prove
 * this Inspector's layer and that pack work together on THIS machine — a
 * Gatekeeper refusal, a missing platform binary, a Node too old for the
 * layer's resolve hook, an SDK the hook cannot reach. Each of those used to
 * surface as the user's next turn failing. So an install runs, against the
 * staged tree, before activation:
 *
 *   1. the pack's own Node runs the layer's launcher in probe mode
 *      (`launcher.mjs --mcpjam-probe`): both launcher guards are installed and
 *      the bridge's vendor import is resolved and loaded exactly as a session
 *      would, then it exits — no port, no model call;
 *   2. the vendor binary's version handshake: Claude Code's native CLI and
 *      Codex's `codex.js` each answer `--version`, and Codex's must name the
 *      `@openai/codex` version the pack carries.
 *
 * A candidate that fails is never activated, so it is never selected; the
 * user keeps working on the permitted previous pack, and the failure is
 * recorded (`install_failed{stage: "probe"}`, `candidate_probe_failed`).
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_HARNESS_MANIFEST } from "./compatibility.js";
import { ensureInspectorLayer } from "./inspector-layer.js";
import type { LocalPackTarget, LocalPlatform, SupportedLocalHarnessId } from "./targets.js";

const PROBE_TIMEOUT_MS = 45_000;

export type RuntimeProbeResult =
  | { ok: true; node: string; vendorVersion: string }
  | { ok: false; message: string };

export interface RuntimeProbeArgs {
  harnessId: SupportedLocalHarnessId;
  /** The staged pack root: `<staging>/<harnessId>`. */
  packRoot: string;
  platform: LocalPlatform;
  target: LocalPackTarget;
  /** Where the Inspector layer is ensured (the runtime root). */
  layerRuntimeRoot?: string;
}

type ProbeImpl = (args: RuntimeProbeArgs) => Promise<RuntimeProbeResult>;
let override: ProbeImpl | null = null;

/** Test seam: fixture packs carry no real Node or vendor binary. */
export function setRuntimeProbeForTests(impl: ProbeImpl | null): void {
  override = impl;
}

/** Run the probe (or the test override). Never throws. */
export async function probeRuntimeCandidate(args: RuntimeProbeArgs): Promise<RuntimeProbeResult> {
  try {
    return await (override ?? realProbe)(args);
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function run(
  file: string,
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    execFile(
      file,
      argv,
      { ...options, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? ((error as { code: number }).code) : 1;
        resolvePromise({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/** What a failed step said, bounded. */
const said = (result: { code: number; stdout: string; stderr: string }) =>
  `exit ${result.code}${result.stderr.trim() ? `; stderr: ${JSON.stringify(result.stderr.trim().slice(-400))}` : ""}`;

async function realProbe(args: RuntimeProbeArgs): Promise<RuntimeProbeResult> {
  const policy = LOCAL_HARNESS_MANIFEST[args.harnessId].runtime;
  if (policy.source !== "managed-bundle") return { ok: false, message: `${args.harnessId} has no managed pack to probe` };
  const node = join(
    args.packRoot,
    args.platform === "win32" ? `${policy.nodeLauncherRelativePath}.exe` : policy.nodeLauncherRelativePath,
  );
  const ensured = await ensureInspectorLayer(args.harnessId, {
    ...(args.layerRuntimeRoot !== undefined ? { runtimeRoot: args.layerRuntimeRoot } : {}),
  });
  if (!ensured.ok) return { ok: false, message: ensured.message };

  // A scratch HOME and nothing else inherited but PATH: the probe must not
  // read or write the user's real configuration.
  const home = await mkdtemp(join(tmpdir(), "mcpjam-probe-"));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    USERPROFILE: home,
    ...(args.platform === "win32" && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    NO_COLOR: "1",
  };
  try {
    const launched = await run(
      node,
      [ensured.layer.launcherPath, "--mcpjam-vendor-root", args.packRoot, "--mcpjam-probe"],
      { cwd: args.packRoot, env },
    );
    const line = launched.stdout.trim().split(/\r?\n/).at(-1) ?? "";
    let reported: { mcpjamProbe?: string; harnessId?: string; node?: string } = {};
    try {
      reported = JSON.parse(line);
    } catch {
      /* reported below */
    }
    if (launched.code !== 0 || reported.mcpjamProbe !== "ok" || reported.harnessId !== args.harnessId) {
      return { ok: false, message: `the Inspector layer did not start on the candidate pack (${said(launched)})` };
    }

    const vendor = await vendorHandshake(args, node, env);
    if (!vendor.ok) return vendor;
    return { ok: true, node: reported.node ?? "", vendorVersion: vendor.version };
  } finally {
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

async function vendorHandshake(
  args: RuntimeProbeArgs,
  node: string,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: true; version: string } | { ok: false; message: string }> {
  if (args.harnessId === "claude-code") {
    const binary = join(
      args.packRoot,
      "node_modules",
      "@anthropic-ai",
      `claude-agent-sdk-${args.target}`,
      args.platform === "win32" ? "claude.exe" : "claude",
    );
    const answered = await run(binary, ["--version"], { cwd: args.packRoot, env });
    const version = /\d+\.\d+\.\d+/.exec(answered.stdout)?.[0];
    if (answered.code !== 0 || version === undefined) {
      return { ok: false, message: `the Claude Code CLI in the candidate pack did not answer --version (${said(answered)})` };
    }
    return { ok: true, version };
  }
  if (args.harnessId === "codex") {
    const pkg = JSON.parse(
      await readFile(join(args.packRoot, "node_modules", "@openai", "codex", "package.json"), "utf8"),
    ) as { version?: string };
    const answered = await run(node, [join("node_modules", "@openai", "codex", "bin", "codex.js"), "--version"], {
      cwd: args.packRoot,
      env,
    });
    if (answered.code !== 0 || typeof pkg.version !== "string" || !answered.stdout.includes(pkg.version)) {
      return {
        ok: false,
        message: `the Codex CLI in the candidate pack did not report @openai/codex ${pkg.version ?? "?"} (${said(answered)})`,
      };
    }
    return { ok: true, version: pkg.version };
  }
  return { ok: false, message: `no vendor handshake is defined for ${args.harnessId}` };
}
