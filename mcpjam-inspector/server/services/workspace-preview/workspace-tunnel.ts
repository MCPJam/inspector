/**
 * Open a workspace port in the hosted browser.
 *
 * The browser runs on a desktop box and the app runs on the shell's box (a
 * conversation's workspace, or an unattended run's pinned image), so a
 * navigation to `http://localhost:<port>` needs two things before it is sent:
 * the workspace's tunnel sidecar running, and the browser box's relay granted
 * that one port. Both are idempotent, so every
 * localhost navigation calls this rather than tracking what an earlier turn or
 * another replica already set up.
 *
 * Nothing here changes the workspace's build, ingress settings or running
 * processes: the sidecar is one extra process, started through envd.
 */
import { createHmac, randomBytes } from "node:crypto";
import { attachRunningSandbox } from "../../utils/computers/attach-sandbox.js";
import {
  ensureComputerReady,
  getComputerSandboxInfo,
} from "../../utils/computers/control-plane-client.js";
import { resolveE2BPortEndpoint } from "../../utils/harness/e2b-port-endpoint.js";
import { logger } from "../../utils/logger.js";
import {
  PREVIEW_TUNNEL_DENIED_PORTS,
  PREVIEW_TUNNEL_DIR,
  PREVIEW_TUNNEL_SCRIPT,
  PREVIEW_TUNNEL_SOURCE,
  PREVIEW_TUNNEL_STATE,
  PREVIEW_TUNNEL_VERSION,
} from "./tunnel-sidecar.js";

export type WorkspacePreviewErrorCode =
  | "https_unsupported"
  | "port_not_allowed"
  | "no_node_runtime"
  | "tunnel_start_failed"
  | "browser_preview_unsupported"
  | "port_unavailable";

/** Model-facing, because the agent is the one that asked for the page. */
const MESSAGES: Record<WorkspacePreviewErrorCode, string> = {
  https_unsupported:
    "preview_unavailable: Browser opens the shell's apps over http only. Use http://localhost:<port>.",
  port_not_allowed:
    "preview_unavailable: that port is reserved. Browser opens apps on ports 1024 to 65535.",
  no_node_runtime:
    "preview_unavailable: the shell's computer has no Node.js, which Browser needs to reach its apps. Check the app from the shell instead.",
  tunnel_start_failed:
    "preview_unavailable: Browser could not connect to the shell's computer. Try again.",
  browser_preview_unsupported:
    "preview_unavailable: this browser was started before it could open the shell's apps. It updates when the browser is idle; try again later.",
  port_unavailable:
    "preview_unavailable: that port is in use on the browser's own computer. Run the app on another port.",
};

export class WorkspacePreviewError extends Error {
  constructor(readonly code: WorkspacePreviewErrorCode) {
    super(MESSAGES[code]);
    this.name = "WorkspacePreviewError";
  }
}

export type PreviewTarget =
  | { kind: "none" }
  | { kind: "port"; port: number }
  | { kind: "refused"; code: WorkspacePreviewErrorCode };

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** Is this URL the workspace's loopback, and which port does it name? */
export function previewTargetForUrl(raw: string): PreviewTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "none" };
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) return { kind: "none" };
  if (url.protocol === "https:") return { kind: "refused", code: "https_unsupported" };
  if (url.protocol !== "http:") return { kind: "none" };
  const port = Number(url.port || 80);
  if (port < 1024 || PREVIEW_TUNNEL_DENIED_PORTS.includes(port))
    return { kind: "refused", code: "port_not_allowed" };
  return { kind: "port", port };
}

/** The per-port key the sidecar checks; a grant for one port opens no other. */
export function previewKeyFor(secret: string, port: number): string {
  return createHmac("sha256", secret).update(`port:${port}`).digest("hex");
}

/** The slice of an attached E2B sandbox the tunnel needs. */
export interface TunnelSandbox {
  sandboxId: string;
  trafficAccessToken?: string;
  getHost(port: number): string;
  files: {
    read(path: string): Promise<string>;
    write(path: string, data: string): Promise<unknown>;
  };
  commands: {
    run(
      command: string,
      options?: { timeoutMs?: number; background?: boolean; envs?: Record<string, string> },
    ): Promise<{ exitCode?: number }>;
  };
}

interface TunnelState {
  version: number;
  port: number;
  pid: number;
  secret: string;
}

export interface WorkspaceTunnel {
  secret: string;
  upstreamUrl: string;
  upstreamHeaders: Record<string, string>;
}

async function readState(sandbox: TunnelSandbox): Promise<TunnelState | undefined> {
  let text: string;
  try {
    text = await sandbox.files.read(PREVIEW_TUNNEL_STATE);
  } catch {
    // No state file is the ordinary first-use answer: start a sidecar.
    return undefined;
  }
  try {
    const value = JSON.parse(text) as Partial<TunnelState>;
    return typeof value.port === "number" &&
      typeof value.pid === "number" &&
      typeof value.secret === "string" &&
      typeof value.version === "number"
      ? (value as TunnelState)
      : undefined;
  } catch {
    // A torn or foreign file is treated like a missing one and replaced.
    return undefined;
  }
}

async function succeeds(sandbox: TunnelSandbox, command: string): Promise<boolean> {
  try {
    const result = await sandbox.commands.run(command, { timeoutMs: 10_000 });
    return result.exitCode === 0;
  } catch {
    // CommandExitError and timeouts both mean "no" for these probes.
    return false;
  }
}

function tunnelFor(sandbox: TunnelSandbox, state: TunnelState): WorkspaceTunnel {
  const endpoint = resolveE2BPortEndpoint(sandbox, state.port, "ws");
  return {
    secret: state.secret,
    upstreamUrl: endpoint.url,
    // Carries a private workspace's traffic access token, so the edge lets the
    // browser box's handshake through; the sidecar's own key still decides.
    upstreamHeaders: endpoint.headers ?? {},
  };
}

const starting = new Map<string, Promise<WorkspaceTunnel>>();

/**
 * Reuse the workspace's sidecar, or start one. Concurrent first navigations in
 * this process share one attempt; two attempts would each start a sidecar and
 * the one whose state file lost would time out.
 */
export function ensureWorkspaceTunnel(
  sandbox: TunnelSandbox,
  options: { pollMs?: number; timeoutMs?: number } = {},
): Promise<WorkspaceTunnel> {
  const running = starting.get(sandbox.sandboxId);
  if (running) return running;
  const attempt = startOrReuseTunnel(sandbox, options).finally(() =>
    starting.delete(sandbox.sandboxId),
  );
  starting.set(sandbox.sandboxId, attempt);
  return attempt;
}

async function startOrReuseTunnel(
  sandbox: TunnelSandbox,
  options: { pollMs?: number; timeoutMs?: number },
): Promise<WorkspaceTunnel> {
  const existing = await readState(sandbox);
  if (
    existing?.version === PREVIEW_TUNNEL_VERSION &&
    (await succeeds(sandbox, `kill -0 ${existing.pid}`))
  )
    return tunnelFor(sandbox, existing);
  if (!(await succeeds(sandbox, "command -v node")))
    throw new WorkspacePreviewError("no_node_runtime");
  if (existing) await succeeds(sandbox, `kill ${existing.pid}`);
  await sandbox.commands.run(`mkdir -p ${PREVIEW_TUNNEL_DIR} && chmod 700 ${PREVIEW_TUNNEL_DIR}`, {
    timeoutMs: 10_000,
  });
  await sandbox.files.write(PREVIEW_TUNNEL_SCRIPT, PREVIEW_TUNNEL_SOURCE);
  const secret = randomBytes(32).toString("hex");
  await sandbox.commands.run(`exec node ${PREVIEW_TUNNEL_SCRIPT}`, {
    background: true,
    envs: { MCPJAM_PREVIEW_SECRET: secret, MCPJAM_PREVIEW_STATE: PREVIEW_TUNNEL_STATE },
  });
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  while (Date.now() < deadline) {
    const state = await readState(sandbox);
    if (state?.secret === secret) return tunnelFor(sandbox, state);
    await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 200));
  }
  throw new WorkspacePreviewError("tunnel_start_failed");
}

export interface PreviewGrantClient {
  previewGrant?(grant: {
    port: number;
    upstreamUrl: string;
    upstreamHeaders: Record<string, string>;
    key: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * Make `url` reachable from the hosted browser, if it names the workspace's
 * loopback. Answers `false` for any other URL, which navigates as before.
 */
export async function preparePreviewNavigation(args: {
  url: string;
  client: PreviewGrantClient;
  attach: () => Promise<TunnelSandbox>;
}): Promise<boolean> {
  const target = previewTargetForUrl(args.url);
  if (target.kind === "none") return false;
  if (target.kind === "refused") throw new WorkspacePreviewError(target.code);
  if (!args.client.previewGrant)
    throw new WorkspacePreviewError("browser_preview_unsupported");
  const tunnel = await ensureWorkspaceTunnel(await args.attach());
  const granted = await args.client.previewGrant({
    port: target.port,
    upstreamUrl: tunnel.upstreamUrl,
    upstreamHeaders: tunnel.upstreamHeaders,
    key: previewKeyFor(tunnel.secret, target.port),
  });
  if (granted.ok) return true;
  throw new WorkspacePreviewError(
    granted.error === "port_unavailable"
      ? "port_unavailable"
      : granted.error === "preview_unsupported"
        ? "browser_preview_unsupported"
        : "tunnel_start_failed",
  );
}

/** The workspace a hosted browser can reach on localhost. */
export interface PreviewWorkspace {
  /** The provider id of the box the app runs on. */
  sandboxId: string;
}

/**
 * A workspace now, or one resolved at navigation time: the public API attaches
 * the browser before it acquires the harness box.
 */
export type PreviewWorkspaceSource =
  | PreviewWorkspace
  | (() => PreviewWorkspace | undefined | Promise<PreviewWorkspace | undefined>);

/**
 * The member's own hosted computer, when Bash runs there and Browser runs on
 * the conversation's box. Resolved on first use, like the Bash tool does it.
 */
export function personalComputerWorkspace(args: {
  authHeader: string;
  projectId: string;
  executionScope?: Parameters<typeof ensureComputerReady>[0]["executionScope"];
}): () => Promise<PreviewWorkspace | undefined> {
  return async () => {
    const ready = await ensureComputerReady({
      bearer: args.authHeader,
      projectId: args.projectId,
      ...(args.executionScope ? { executionScope: args.executionScope } : {}),
    });
    if (!ready.ok) return undefined;
    const info = await getComputerSandboxInfo({ computerId: ready.value.computerId });
    return info.ok && info.value.providerComputerId
      ? { sandboxId: info.value.providerComputerId }
      : undefined;
  };
}

/**
 * A server that logs its listen address prints `0.0.0.0`, and the relay
 * answers only the loopback names a page can keep as its origin. Browser
 * judges a navigation by this URL too, so the origin it allows is the one the
 * browser opens.
 */
export function loopbackUrl(raw: string): string {
  if (!URL.canParse(raw)) return raw;
  const url = new URL(raw);
  if (url.hostname !== "0.0.0.0") return raw;
  url.hostname = "localhost";
  return url.href;
}

/**
 * Before a navigation leaves the inspector: open the workspace port it names.
 * Answers the action to send, or the model-facing refusal.
 */
export async function openPreviewForNavigation<A extends { kind: string; url?: string }>(args: {
  action: A;
  workspace: PreviewWorkspaceSource | undefined;
  handle: { engine: string; client: PreviewGrantClient };
  attach?: (sandboxId: string) => Promise<TunnelSandbox>;
}): Promise<{ action: A } | { refusal: string }> {
  const { action } = args;
  if (args.handle.engine !== "hosted") return { action };
  if (action.kind !== "navigate" || !action.url) return { action };
  // Resolving the workspace can start the member's computer, so a URL that
  // names no workspace port never gets that far.
  if (previewTargetForUrl(action.url).kind === "none") return { action };
  const attach = args.attach ?? attachRunningSandbox;
  try {
    const workspace =
      typeof args.workspace === "function" ? await args.workspace() : args.workspace;
    if (!workspace) return { action };
    const sandboxId = workspace.sandboxId;
    const granted = await preparePreviewNavigation({
      url: action.url,
      client: args.handle.client,
      attach: () => attach(sandboxId),
    });
    return { action: granted ? { ...action, url: loopbackUrl(action.url) } : action };
  } catch (error) {
    const code = error instanceof WorkspacePreviewError ? error.code : "tunnel_start_failed";
    logger.warn("[workspace-preview] could not open a workspace port", {
      code,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return {
      refusal: error instanceof WorkspacePreviewError ? error.message : MESSAGES.tunnel_start_failed,
    };
  }
}
