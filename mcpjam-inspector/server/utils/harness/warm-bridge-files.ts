import { createHash } from "node:crypto";
import type { HarnessV1 } from "@ai-sdk/harness";
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
  return (
    source +
    `
async function ${marker}() {
  if (process.env.MCPJAM_HOSTED_BRIDGE !== "1") return;
  const fs = await import("node:fs");
  const at = process.argv.indexOf("--bridge-state-dir");
  if (at < 0 || !process.argv[at + 1]) return;
  const dir = process.argv[at + 1];
  let lastActiveAt = Date.now();
  setInterval(() => {
    try {
      const meta = JSON.parse(fs.readFileSync(dir + "/bridge-meta.json", "utf8"));
      if (meta.pid !== process.pid) return;
      if (meta.state === "running") { lastActiveAt = Date.now(); return; }
      if (!["waiting", "done", "init"].includes(meta.state)) return;
      let expiry = lastActiveAt + ${WARM_BRIDGE_WINDOW_MS};
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

/** Shared by image baking and hosted dispatch so their recipes cannot drift. */
export function withWarmBridgeBootstrap<T extends HarnessV1>(runtime: T): T {
  return new Proxy(runtime, {
    get(target, key) {
      if (key === "getBootstrap" && target.getBootstrap) {
        return async (...args: Parameters<NonNullable<T["getBootstrap"]>>) => {
          const bootstrap = await target.getBootstrap!(...args);
          return {
            ...bootstrap,
            files: bootstrap.files.map((file) =>
              file.path.endsWith("/bridge.mjs")
                ? { ...file, content: patchWarmBridgeExpiry(file.content) }
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
