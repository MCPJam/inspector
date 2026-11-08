import { createHash } from "node:crypto";
import { posix } from "node:path";
import {
  harnessStateDirectoryPath,
  type HarnessV1,
  type HarnessV1StartOptions,
} from "@ai-sdk/harness";
import { resolveSandboxHomeDir } from "@ai-sdk/harness/utils";
import { patchWarmClaudeQuery } from "./warm-claude-query.js";
import { shellQuote } from "./shell-quote.js";
import { processBirthIdentity, WARM_BRIDGE_WINDOW_MS } from "./warm-bridge.js";

export const WARM_BRIDGE_FILE = "mcpjam-warm.json";

/** Only hashes, process identity and expiry cross the command line. */
export function warmBridgeCommand(args: {
  directory: string;
  configuration: string;
  token: string;
  port: number;
  park: boolean;
}): string {
  const script = `
const fs = require("node:fs");
const [dir, configuration, tokenHash, port, park] = process.argv.slice(1);
const birth = ${processBirthIdentity.toString()};
try {
  const meta = JSON.parse(fs.readFileSync(dir + "/bridge-meta.json", "utf8"));
  if (!Number.isSafeInteger(meta.pid) || meta.pid <= 0 || meta.port !== Number(port) || !["waiting", "done"].includes(meta.state)) process.exit(1);
  const stat = fs.readFileSync("/proc/" + meta.pid + "/stat", "utf8");
  const born = birth(stat);
  if (!born) process.exit(1);
  const path = dir + "/${WARM_BRIDGE_FILE}";
  if (park === "true") {
    const identity = { pid: meta.pid, birthIdentity: born, configuration, tokenHash, expiresAt: Date.now() + ${WARM_BRIDGE_WINDOW_MS} };
    fs.writeFileSync(path + ".tmp", JSON.stringify(identity), { mode: 384 });
    fs.renameSync(path + ".tmp", path);
  } else {
    const saved = JSON.parse(fs.readFileSync(path, "utf8"));
    if (saved.pid !== meta.pid || saved.birthIdentity !== born || saved.configuration !== configuration || saved.tokenHash !== tokenHash || saved.expiresAt <= Date.now() || saved.expiresAt > Date.now() + ${WARM_BRIDGE_WINDOW_MS}) process.exit(1);
  }
  process.stdout.write("ready");
} catch { process.exit(1); }
`;
  return [
    "node",
    "-e",
    script,
    args.directory,
    args.configuration,
    createHash("sha256").update(args.token).digest("hex"),
    String(args.port),
    String(args.park),
  ]
    .map(shellQuote)
    .join(" ");
}

/** Each bridge reaps itself after the idle window, even without a later spawn. */
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
  setInterval(() => {
    try {
      const meta = JSON.parse(fs.readFileSync(dir + "/bridge-meta.json", "utf8"));
      if (meta.pid !== process.pid || meta.state !== mcpjamWarmLifecycle?.state) return;
      if (!["waiting", "done", "init"].includes(meta.state)) return;
      let expiry = mcpjamWarmLifecycle.since + ${WARM_BRIDGE_WINDOW_MS};
      if (fs.existsSync(dir + "/${WARM_BRIDGE_FILE}")) {
        try {
          const saved = JSON.parse(fs.readFileSync(dir + "/${WARM_BRIDGE_FILE}", "utf8"));
          if (saved.pid === process.pid && Number.isFinite(saved.expiresAt) &&
              saved.expiresAt <= Date.now() + ${WARM_BRIDGE_WINDOW_MS}) expiry = Math.max(expiry, saved.expiresAt);
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

/** Bind control replies to the socket that owns the current turn. The
 *  anchors carry no indentation: the Claude Code bridge is the vendor's own
 *  bundle, while the Codex bridge is this repository's esbuild bundle of the
 *  same framework dispatcher, and the two indent differently. */
export function fenceWarmBridgeSocket(source: string): string {
  const start = 'case "start": {';
  const until = "let turnFinished;";
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
 * its own file so toggling reuse off on the same box really runs the original. */
function withPilotEntrypoint<T extends object>(
  sandbox: T,
  directory: string,
): T {
  const original =
    "node " + shellQuote(posix.join(directory, "bridge.mjs")) + " ";
  const pilot =
    "node " + shellQuote(posix.join(directory, "warm-bridge.mjs")) + " ";
  return new Proxy(sandbox, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (key === "restricted" && typeof value === "function")
        return () => withPilotEntrypoint(value.call(target), directory);
      if (key === "spawn" && typeof value === "function")
        return (request: { command: string }) => {
          if (!request.command.startsWith(original))
            throw new Error("The hosted agent launch command has changed.");
          return value.call(target, {
            ...request,
            command: pilot + request.command.slice(original.length),
          });
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Applies only to the pilot bootstrap selected by the hosted turn. */
export function withWarmBridgeBootstrap<T extends HarnessV1>(runtime: T): T {
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
          // The framework installs every recipe under the sandbox's own HOME,
          // which is where the adapter launches the bridge from.
          const directory = posix.resolve(
            harnessStateDirectoryPath({
              sandboxHomeDir: await resolveSandboxHomeDir({
                sandbox: options.sandboxSession,
                abortSignal: options.abortSignal,
              }),
            }),
            recipe.bootstrapDir,
          );
          return target.doStart({
            ...options,
            sandboxSession: withPilotEntrypoint(
              options.sandboxSession,
              directory,
            ),
          });
        };
      if (key === "getBootstrap" && target.getBootstrap) {
        return async (...args: Parameters<NonNullable<T["getBootstrap"]>>) => {
          const bootstrap = await target.getBootstrap!(...args);
          return {
            ...bootstrap,
            files: bootstrap.files.map((file) =>
              file.path.endsWith("/bridge.mjs")
                ? {
                    ...file,
                    path: posix.join(
                      posix.dirname(file.path),
                      "warm-bridge.mjs",
                    ),
                    content: patchWarmBridgeExpiry(
                      fenceWarmBridgeSocket(
                        runtime.harnessId === "claude-code"
                          ? patchWarmClaudeQuery(file.content)
                          : file.content,
                      ),
                    ),
                  }
                : file,
            ),
          };
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
