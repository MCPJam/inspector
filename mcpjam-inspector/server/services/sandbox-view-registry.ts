import {
  sandboxViewIdentity,
  type SandboxViewLease,
} from "./sandbox-view-lease.js";
import {
  sandboxViewHeaders,
  SANDBOX_VIEW_DENY_POLICY,
} from "../utils/sandbox-view-response.js";
import { randomUUID } from "node:crypto";
import type { PreparedSandboxView } from "@mcpjam/sdk/widget-runtime";
import { renderSandboxProxyHtml } from "../routes/apps/mcp-apps/sandbox-proxy-html.js";
import {
  SANDBOX_VIEW_LEASE_MS,
  checkedSandboxPolicy,
  openSandboxViewCapability,
  resolveSandboxViewPolicy,
  sandboxDigest,
  sandboxSourceDigest,
  sealSandboxViewCapability,
  type SandboxViewInput,
} from "./sandbox-view-policy.js";

export const SANDBOX_VIEW_PATH = "/api/apps/mcp-apps/sandbox-proxy";
const MAX_VIEWS = 32;
const MAX_OWNER_VIEWS = 16;

/**
 * A single UUID label under `localhost`, the only hostname shape the registry
 * mints. Every such host belongs to the App partition: an admitted one serves
 * its document and the rest 404. Other names fall through to the Inspector.
 */
const APP_HOST =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.localhost\.?(?::\d*)?$/;

interface Entry {
  id: string;
  fingerprint: string;
  lease: SandboxViewLease;
  proxyUrl: string;
  timer?: ReturnType<typeof setTimeout>;
}
export function sandboxViewFingerprint(input: SandboxViewInput): string {
  return sandboxDigest(
    JSON.stringify([
      input.viewInstanceId,
      input.source,
      input.html,
      input.policy,
      input.mode,
      input.hostOrigin,
    ]),
  );
}

function notFound(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: sandboxViewHeaders(SANDBOX_VIEW_DENY_POLICY),
  });
}

/**
 * Owns local App document leases; never stores App HTML. Each admission gets
 * its own `<uuid>.localhost` origin on the port the browser already uses to
 * reach the Inspector, so the document loads wherever that port is forwarded
 * (Docker, SSH tunnels, devcontainers) and needs no listener of its own.
 */
export class SandboxViewRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly viewKeys = new Map<string, string>();

  constructor(private readonly now = Date.now) {}

  private arm(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => this.dispose(entry.id, entry.lease.ownerHash),
      Math.max(1, entry.lease.expiresAt - this.now()),
    );
    entry.timer.unref?.();
  }

  /**
   * `port` is the port the browser used to reach the Inspector for this
   * admission ("" for the scheme default); the App origin reuses it.
   */
  async prepare(
    input: SandboxViewInput,
    ownerHash: string,
    port: string,
    signal?: AbortSignal,
  ): Promise<PreparedSandboxView> {
    signal?.throwIfAborted();
    const keyHash = sandboxDigest(
      JSON.stringify([ownerHash, input.viewInstanceId]),
    );
    const fingerprint = sandboxViewFingerprint(input);
    const oldId = this.viewKeys.get(keyHash);
    const old = oldId ? this.entries.get(oldId) : undefined;
    if (old) {
      if (old.fingerprint !== fingerprint || old.lease.expiresAt <= this.now())
        throw new Error("App admission changed or expired; reopen the App");
      old.lease.expiresAt = this.now() + SANDBOX_VIEW_LEASE_MS;
      this.arm(old);
      return this.response(old);
    }
    return this.create(input, ownerHash, keyHash, fingerprint, port);
  }

  private create(
    input: SandboxViewInput,
    ownerHash: string,
    keyHash: string,
    fingerprint: string,
    port: string,
  ): PreparedSandboxView {
    if (input.admissionId)
      throw new Error("App admission is no longer active; reopen the App");
    if (
      this.entries.size >= MAX_VIEWS ||
      [...this.entries.values()].filter(
        (entry) => entry.lease.ownerHash === ownerHash,
      ).length >= MAX_OWNER_VIEWS
    )
      throw new Error("Too many open Apps; close an App and try again");
    if (!/^\d{0,5}$/.test(port))
      throw new Error("App document port is invalid");
    const policy = checkedSandboxPolicy(
      `${resolveSandboxViewPolicy(input, ownerHash)}, frame-ancestors 'self' ${input.hostOrigin}`,
    );
    const id = randomUUID();
    const leaseBase = {
      generation: id,
      keyHash,
      ownerHash,
      sourceHash: sandboxSourceDigest(input.source),
      htmlHash: sandboxDigest(input.html),
      policyHash: sandboxDigest(policy),
      hostOrigin: input.hostOrigin,
      // A fresh loopback hostname gives every admission its own browser
      // origin on the shared port. `respond` rejects any other Host.
      viewOrigin: `http://${id}.localhost${port ? `:${port}` : ""}`,
      policy,
    };
    const lease: SandboxViewLease = {
      ...leaseBase,
      identityHash: sandboxViewIdentity(leaseBase),
      expiresAt: this.now() + SANDBOX_VIEW_LEASE_MS,
    };
    const capability = sealSandboxViewCapability(
      lease.keyHash,
      lease.identityHash,
      lease.viewOrigin,
    );
    const entry: Entry = {
      id,
      fingerprint,
      lease,
      proxyUrl: `${lease.viewOrigin}${SANDBOX_VIEW_PATH}?view_token=${capability}`,
    };
    this.entries.set(id, entry);
    this.viewKeys.set(keyHash, id);
    this.arm(entry);
    return this.response(entry);
  }

  /**
   * Answers every request to an App host: the admitted document at its exact
   * origin, path and capability, and 404 for anything else. Returns null for
   * other hosts so the Inspector handles them.
   */
  respond(request: Request): Response | null {
    const host = (request.headers.get("host") ?? "").toLowerCase();
    if (!APP_HOST.test(host)) return null;
    const entry = this.entries.get(host.slice(0, host.indexOf(".")));
    if (
      !entry ||
      entry.lease.expiresAt <= this.now() ||
      request.method !== "GET" ||
      `http://${host}` !== entry.lease.viewOrigin
    )
      return notFound();
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.pathname !== SANDBOX_VIEW_PATH) return notFound();
    try {
      const claim = openSandboxViewCapability(
        url.searchParams.get("view_token") ?? "",
        entry.lease.viewOrigin,
      );
      if (
        claim.keyHash !== entry.lease.keyHash ||
        claim.identityHash !== entry.lease.identityHash
      )
        return notFound();
    } catch {
      // Invalid public capabilities get the same restrictive 404.
      return notFound();
    }
    return new Response(
      renderSandboxProxyHtml({
        htmlSha256: entry.lease.htmlHash,
        hostOrigin: entry.lease.hostOrigin,
        admissionId: entry.id,
      }),
      { status: 200, headers: sandboxViewHeaders(entry.lease.policy) },
    );
  }

  private response(entry: Entry): PreparedSandboxView {
    return {
      admissionId: entry.id,
      proxyUrl: entry.proxyUrl,
      htmlSha256: entry.lease.htmlHash,
      expiresAt: entry.lease.expiresAt,
    };
  }
  dispose(id: string, ownerHash: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.lease.ownerHash !== ownerHash) return;
    this.entries.delete(id);
    this.viewKeys.delete(entry.lease.keyHash);
    clearTimeout(entry.timer);
  }
}
export const sandboxViews = new SandboxViewRegistry();
