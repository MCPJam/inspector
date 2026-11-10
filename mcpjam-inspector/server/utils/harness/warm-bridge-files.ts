import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  harnessSessionDataDirectoryPath,
  harnessStateDirectoryPath,
  type HarnessV1,
  type HarnessV1StartOptions,
} from "@ai-sdk/harness";
import { resolveSandboxHomeDir } from "@ai-sdk/harness/utils";
import { patchWarmClaudeQuery } from "./warm-claude-query.js";
import { patchClaudeForwardingResume } from "./forwarding/claude-resume.js";
import { shellQuote } from "./shell-quote.js";
import { processBirthIdentity, WARM_BRIDGE_WINDOW_ENV } from "./warm-bridge.js";

export const WARM_BRIDGE_FILE = "mcpjam-warm.json";

/** Only hashes, process identity, expiry and the window cross the command line. */
export function warmBridgeCommand(args: {
  sessionId: string;
  configuration: string;
  token: string;
  port: number;
  park: boolean;
  /** The box's idle window: a parked bridge is reusable for this long. */
  windowMs: number;
  includeHome?: boolean;
}): string {
  // Use the adapter's session encoding; resolve HOME in the existing probe.
  const directory = posix.join(
    harnessSessionDataDirectoryPath({
      stateDirectory: harnessStateDirectoryPath({ sandboxHomeDir: "." }),
      sessionId: args.sessionId,
    }),
    "bridge",
  );
  const script = `
const fs = require("node:fs");
const path = require("node:path");
const home = require("node:os").homedir();
if (!path.isAbsolute(home) || home.includes("\\0")) process.exit(1);
const [relativeDir, configuration, tokenHash, port, park, windowArg] = process.argv.slice(1);
const windowMs = Number(windowArg);
if (!Number.isSafeInteger(windowMs) || windowMs <= 0) process.exit(1);
const dir = path.join(home, relativeDir);
const birth = ${processBirthIdentity.toString()};
try {
  const meta = JSON.parse(fs.readFileSync(dir + "/bridge-meta.json", "utf8"));
  if (!Number.isSafeInteger(meta.pid) || meta.pid <= 0 || meta.port !== Number(port) || !["waiting", "done"].includes(meta.state)) process.exit(1);
  const stat = fs.readFileSync("/proc/" + meta.pid + "/stat", "utf8");
  const born = birth(stat);
  if (!born) process.exit(1);
  const path = dir + "/${WARM_BRIDGE_FILE}";
  if (park === "true") {
    const identity = { pid: meta.pid, birthIdentity: born, configuration, tokenHash, expiresAt: Date.now() + windowMs };
    fs.writeFileSync(path + ".tmp", JSON.stringify(identity), { mode: 384 });
    fs.renameSync(path + ".tmp", path);
  } else {
    const saved = JSON.parse(fs.readFileSync(path, "utf8"));
    if (saved.pid !== meta.pid || saved.birthIdentity !== born || saved.configuration !== configuration || saved.tokenHash !== tokenHash || saved.expiresAt <= Date.now() || saved.expiresAt > Date.now() + windowMs) process.exit(1);
  }
  process.stdout.write(${args.includeHome ? 'JSON.stringify({ ready: true, home })' : '"ready"'});
} catch { process.exit(1); }
`;
  return [
    "node",
    "-e",
    script,
    directory,
    args.configuration,
    createHash("sha256").update(args.token).digest("hex"),
    String(args.port),
    String(args.park),
    String(args.windowMs),
  ]
    .map(shellQuote)
    .join(" ");
}

/**
 * Each bridge reaps itself after the idle window, even without a later spawn.
 * The window is read at run time from `WARM_BRIDGE_WINDOW_ENV`; a bridge
 * started without one never reaps itself, and its box's pause stops it.
 */
export function patchWarmBridgeExpiry(source: string): string {
  const marker = "mcpjamWarmBridgeExpiry";
  if (source.includes(marker)) return source;
  const lifecycle = "const writeBridgeMeta = async (state) => {";
  if (!source.includes(lifecycle)) throw new Error("The bridge lifecycle protocol changed.");
  return (
    source.replace(lifecycle, lifecycle + "\n    mcpjamWarmLifecycle = { state, since: Date.now() };") +
    `
var mcpjamWarmLifecycle;
async function ${marker}() {
  const fs = await import("node:fs");
  const at = process.argv.indexOf("--bridge-state-dir");
  if (at < 0 || !process.argv[at + 1]) return;
  const dir = process.argv[at + 1];
  const windowMs = Number(process.env.${WARM_BRIDGE_WINDOW_ENV});
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) return;
  setInterval(() => {
    try {
      const meta = JSON.parse(fs.readFileSync(dir + "/bridge-meta.json", "utf8"));
      if (meta.pid !== process.pid || meta.state !== mcpjamWarmLifecycle?.state) return;
      if (!["waiting", "done", "init"].includes(meta.state)) return;
      let expiry = mcpjamWarmLifecycle.since + windowMs;
      if (fs.existsSync(dir + "/${WARM_BRIDGE_FILE}")) {
        try {
          const saved = JSON.parse(fs.readFileSync(dir + "/${WARM_BRIDGE_FILE}", "utf8"));
          if (saved.pid === process.pid && Number.isFinite(saved.expiresAt) &&
              saved.expiresAt <= Date.now() + windowMs) expiry = Math.max(expiry, saved.expiresAt);
        } catch {
          // A stale marker cannot extend the lifetime of a replacement process.
        }
      }
      if (Number.isFinite(expiry) && Date.now() >= expiry) process.exit(0);
    } catch {
      // Unreadable lifecycle state must never kill an approval or active turn.
    }
  }, 5000).unref();
}

void ${marker}();
`
  );
}

/** Bind control replies to the socket that owns the current turn. */
export function fenceWarmBridgeSocket(source: string): string {
  const start = '      case "start": {';
  const until = "        let turnFinished;";
  const begin = source.indexOf(start);
  const end = source.indexOf(until, begin);
  if (
    begin < 0 ||
    end < 0 ||
    !source.slice(begin, end).includes("turnAbort?.abort()")
  )
    throw new Error("The bridge cannot fence overlapping turns.");
  const fenced =
    source.slice(0, begin) +
    start +
    `
        if (activeTurn != null) {
          sendControl(ws, {type:"error",error:"Another message is waiting or running."});
          return;
        }
        bufferedToolResults.length = 0;
` +
    source.slice(end);
  let guarded = fenced;
  for (const control of [
    'case "tool-result": {',
    'case "tool-approval-response": {',
    'case "abort":',
  ]) {
    if (!guarded.includes(control))
      throw new Error("The bridge control protocol changed.");
    guarded = guarded.replace(
      control,
      control +
        "\n        if (!activeTurn || ws !== activeSocket || turnAbort?.signal.aborted) return;",
    );
  }
  for (const control of [
    'case "resume":',
    'case "destroy":',
    'case "stop":',
  ]) {
    if (!guarded.includes(control))
      throw new Error("The bridge ownership protocol changed.");
    guarded = guarded.replace(
      control,
      control +
        `
        if (activeTurn && activeSocket?.readyState === WS_OPEN && ws !== activeSocket) {
          sendControl(ws, {type:"error",error:"Another connection owns this message."});
          return;
        }`,
    );
  }
  const finish = "if (activeTurn === thisTurn) {";
  if (!guarded.includes(finish))
    throw new Error("The bridge turn cleanup protocol changed.");
  return guarded.replace(
    finish,
    finish +
      `
            for (const pending of pendingToolResults.values()) pending.resolve({output:"The message ended.",isError:true});
            for (const resolve of pendingToolApprovals.values()) resolve({approved:false,reason:"The message ended."});
            pendingToolResults.clear();
            pendingToolApprovals.clear();
            bufferedToolResults.length = 0;`,
  );
}

/** The SDK always launches bridge.mjs. Keep the experimental entrypoint in
 * its own file so toggling reuse off on the same box really runs the original,
 * and hand it the idle window through its environment. */
function withPilotEntrypoint<T extends object>(
  sandbox: T,
  directory: string,
  windowMs: number | undefined,
): T {
  const original =
    "node " + shellQuote(posix.join(directory, "bridge.mjs")) + " ";
  const pilot =
    "node " + shellQuote(posix.join(directory, "warm-bridge.mjs")) + " ";
  return new Proxy(sandbox, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "restricted" && typeof value === "function")
        return () =>
          withPilotEntrypoint(value.call(target), directory, windowMs);
      if (key === "spawn" && typeof value === "function")
        return (request: { command: string; env?: Record<string, string> }) => {
          if (!request.command.startsWith(original))
            throw new Error("The hosted agent launch command has changed.");
          return value.call(target, {
            ...request,
            command: pilot + request.command.slice(original.length),
            ...(windowMs
              ? {
                  env: {
                    ...request.env,
                    [WARM_BRIDGE_WINDOW_ENV]: String(windowMs),
                  },
                }
              : {}),
          });
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Applies only to the pilot bootstrap selected by the hosted turn. `windowMs`
 * is the box's idle window, handed to the bridge at spawn; the bootstrap files
 * themselves never carry it, so the baked install does not depend on it.
 */
export function withWarmBridgeBootstrap<T extends HarnessV1>(
  runtime: T,
  windowMs?: number,
): T {
  return new Proxy(runtime, {
    get(target, key) {
      if (key === "doStart" && target.getBootstrap)
        return async (options: HarnessV1StartOptions) => {
          const recipe = await target.getBootstrap?.({
            abortSignal: options.abortSignal,
          });
          if (!recipe)
            throw new Error(
              "The hosted agent installation directory is unavailable.",
            );
          const sandboxHomeDir = await resolveSandboxHomeDir({
            sandbox: options.sandboxSession,
            ...(options.abortSignal
              ? { abortSignal: options.abortSignal }
              : {}),
          });
          const directory = posix.resolve(
            harnessStateDirectoryPath({ sandboxHomeDir }),
            recipe.bootstrapDir,
          );
          return target.doStart({
            ...options,
            sandboxSession: withPilotEntrypoint(
              options.sandboxSession,
              directory,
              windowMs,
            ),
          });
        };
      if (key === "getBootstrap" && target.getBootstrap) {
        return async (...args: Parameters<NonNullable<T["getBootstrap"]>>) => {
          const bootstrap = await target.getBootstrap!(...args);
          return {
            ...bootstrap,
            files: bootstrap.files.map((file) => {
              if (!file.path.endsWith("/bridge.mjs")) return file;
              const content = patchWarmBridgeExpiry(
                fenceWarmBridgeSocket(
                  runtime.harnessId === "claude-code"
                    ? patchWarmClaudeQuery(file.content)
                    : file.content,
                ),
              );
              return {
                ...file,
                path: posix.join(posix.dirname(file.path), "warm-bridge.mjs"),
                // Both routing modes share one artifact. The native route's
                // outer wrapper still decides whether to call its refresh hook.
                content: runtime.harnessId === "claude-code"
                  ? patchClaudeForwardingResume(content)
                  : content,
              };
            }),
          };
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
