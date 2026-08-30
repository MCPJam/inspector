/**
 * W1 internal debug route — the hosted-browser pipeline, end to end.
 *
 * It proves the wave's exit criterion: reserve a DESKTOP computer, boot browserd
 * inside it, navigate, and screenshot. It is deliberately minimal and doubly
 * gated: it is only MOUNTED when `COMPUTER_BROWSER_DEBUG_ENABLED === "1"` (see
 * app.ts / index.ts), and every request is authenticated by the internal
 * service token (`internalServiceAuthMiddleware`, the same gate as the backend
 * doorbell). The service token proves the caller is trusted; the `bearer` in the
 * body is the USER whose desktop is reserved.
 *
 * All orchestration + cleanup live in `runBrowserProbe`; this file only builds
 * the live seams (Convex reserve/sandbox-info, `Sandbox.connect`, the E2B →
 * BrowserdSandbox adapter, the real client) and the bundle bytes.
 */
import { Hono } from "hono";
import { Sandbox } from "e2b";
import { internalServiceAuthMiddleware } from "../../middleware/internal-service-auth.js";
import {
  ensureComputerReady,
  getComputerSandboxInfo,
} from "../../utils/computers/control-plane-client.js";
import { bootBrowserd, type BrowserdSandbox } from "../../services/browserd/boot-browserd.js";
import { BrowserdClient } from "../../services/browserd/browserd-client.js";
import {
  runBrowserProbe,
  type ProbeSandbox,
} from "../../services/browserd/browser-debug-probe.js";
import { MCPJAM_BROWSERD_BUNDLE_BASE64 } from "../../services/browserd/dist/mcpjam-browserd-bundle.generated.js";
import { withKeyedLock } from "../../services/browserd/probe-lock.js";
import { reportRouteFailure } from "../../utils/route-error-report.js";

const internalComputerBrowserDebug = new Hono();

internalComputerBrowserDebug.use("*", internalServiceAuthMiddleware());

/**
 * The daemon bundle bytes. Decoded from the const that the bundler embeds INTO
 * the server build (base64), so it is always present in the production Docker
 * image — a sibling `.mjs` resolved by path would be absent, since the final
 * Docker stage copies only `dist/`.
 */
let cachedBundle: Uint8Array | null = null;
function loadBundle(): Uint8Array {
  if (!cachedBundle) {
    cachedBundle = new Uint8Array(Buffer.from(MCPJAM_BROWSERD_BUNDLE_BASE64, "base64"));
  }
  return cachedBundle;
}

/** Adapt a connected E2B sandbox to the boot recipe's `BrowserdSandbox`. */
function adaptSandbox(sandbox: Sandbox): BrowserdSandbox {
  return {
    async runBackground(command, { envs, onStdout }) {
      const handle = await sandbox.commands.run(command, {
        background: true,
        envs,
        timeoutMs: 0,
        onStdout,
      });
      return { kill: () => handle.kill(), wait: () => handle.wait() };
    },
    getHost: (port) => sandbox.getHost(port),
  };
}

function connectProbeSandbox(sandbox: Sandbox): ProbeSandbox {
  return {
    async writeBundle(path, content) {
      const slash = path.lastIndexOf("/");
      const dir = slash > 0 ? path.slice(0, slash) : "";
      if (dir) {
        try {
          await sandbox.files.makeDir(dir);
        } catch {
          // Idempotent: a real problem surfaces as the write's own error.
        }
      }
      const data = new ArrayBuffer(content.byteLength);
      new Uint8Array(data).set(content);
      await sandbox.files.write(path, data);
    },
    browserd: adaptSandbox(sandbox),
    // Never kill the durable computer here — only the daemon is stopped, by the
    // probe's own cleanup. `Sandbox.connect` holds no resource to release.
    disconnect: async () => {},
  };
}

internalComputerBrowserDebug.post("/probe", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    projectId?: unknown;
    bearer?: unknown;
    url?: unknown;
  } | null;
  const projectId = typeof body?.projectId === "string" ? body.projectId : "";
  const bearer = typeof body?.bearer === "string" ? body.bearer : "";
  const url = typeof body?.url === "string" ? body.url : "";
  if (!projectId || !bearer || !url) {
    return c.json({ ok: false, error: "projectId, bearer, and url are required" }, 400);
  }

  try {
    const bundle = loadBundle();
    // Serialize per user+project so two probes can't collide on the same
    // sandbox's fixed port/profile. bearer identifies the user; it is used only
    // as a lock key here and never logged.
    const result = await withKeyedLock(`${projectId}:${bearer}`, () =>
      runBrowserProbe(
      {
        reserveDesktop: async () => {
          const reserved = await ensureComputerReady({
            bearer,
            projectId,
            runtimeKind: "desktop-browser",
          });
          if (!reserved.ok) {
            throw new Error(`reserve failed (${reserved.status}): ${reserved.error}`);
          }
          return { computerId: reserved.value.computerId };
        },
        resolveSandboxId: async (computerId) => {
          const info = await getComputerSandboxInfo({ computerId });
          if (!info.ok) {
            throw new Error(`sandbox-info failed (${info.status}): ${info.error}`);
          }
          if (!info.value.providerComputerId) {
            throw new Error("computer has no vendor sandbox id yet");
          }
          return info.value.providerComputerId;
        },
        connect: async (sandboxId) => connectProbeSandbox(await Sandbox.connect(sandboxId)),
        boot: bootBrowserd,
        createClient: (baseUrl, boot) => new BrowserdClient({ baseUrl, bearer: boot }),
      },
      { url, bundle },
      ),
    );
    return c.json({ ok: true, ...result });
  } catch (error) {
    // Route through the repo's error-origin/Sentry policy, not a bare log
    // (AGENTS.md). The whole probe is our own infra (control plane, E2B,
    // browserd), so the hop is internal. Only projectId is safe to attach — the
    // bearer is a secret.
    reportRouteFailure("hosted browser debug probe failed", error, {
      source: "computer-browser-debug.probe",
      hop: "mcpjam_internal",
      context: { projectId },
    });
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ ok: false, error: message }, 502);
  }
});

export default internalComputerBrowserDebug;
