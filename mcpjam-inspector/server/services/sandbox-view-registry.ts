import {
  sandboxViewIdentity,
  type SandboxViewLease,
} from "./sandbox-view-lease.js";
import {
  sandboxViewHeaders,
  SANDBOX_VIEW_DENY_POLICY,
} from "../utils/sandbox-view-response.js";
import { createServer, type Server } from "node:http";
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

interface Entry {
  id: string;
  fingerprint: string;
  lease: SandboxViewLease;
  server: Server;
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

/** Owns only document metadata and bounded loopback listeners; never stores App HTML. */
export class SandboxViewRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly viewKeys = new Map<string, string>();
  private reserved = 0;
  private closing = false;
  private readonly reservedOwners = new Map<string, number>();
  private readonly pending = new Map<
    string,
    { fingerprint: string; result: Promise<PreparedSandboxView> }
  >();

  constructor(
    private readonly now = Date.now,
    private readonly port = 0,
  ) {}

  private arm(entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(
      () => this.dispose(entry.id, entry.lease.ownerHash),
      Math.max(1, entry.lease.expiresAt - this.now()),
    );
    entry.timer.unref?.();
  }

  async prepare(
    input: SandboxViewInput,
    ownerHash: string,
    signal?: AbortSignal,
  ): Promise<PreparedSandboxView> {
    if (this.closing) throw new Error("App document service is closed");
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
    const pending = this.pending.get(keyHash);
    if (pending) {
      if (pending.fingerprint !== fingerprint)
        throw new Error("App admission changed while being prepared");
      return pending.result;
    }
    const result = this.create(input, ownerHash, keyHash, fingerprint, signal);
    this.pending.set(keyHash, { fingerprint, result });
    try {
      return await result;
    } finally {
      this.pending.delete(keyHash);
    }
  }

  private async create(
    input: SandboxViewInput,
    ownerHash: string,
    keyHash: string,
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<PreparedSandboxView> {
    if (input.admissionId)
      throw new Error("App admission is no longer active; reopen the App");
    if (
      this.entries.size + this.reserved >= MAX_VIEWS ||
      [...this.entries.values()].filter(
        (entry) => entry.lease.ownerHash === ownerHash,
      ).length +
        (this.reservedOwners.get(ownerHash) ?? 0) >=
        MAX_OWNER_VIEWS
    )
      throw new Error("Too many open Apps; close an App and try again");
    const policy = checkedSandboxPolicy(
      `${resolveSandboxViewPolicy(input, ownerHash)}, frame-ancestors 'self' ${input.hostOrigin}`,
    );
    this.reserved++;
    this.reservedOwners.set(
      ownerHash,
      (this.reservedOwners.get(ownerHash) ?? 0) + 1,
    );
    let entry: Entry | undefined;
    let server: Server | undefined;
    try {
      signal?.throwIfAborted();
      {
        server = createServer((request, response) => {
          response.statusCode = 404;
          for (const [name, value] of Object.entries(
            sandboxViewHeaders(SANDBOX_VIEW_DENY_POLICY),
          ))
            response.setHeader(name, value);
          if (
            !entry ||
            entry.lease.expiresAt <= this.now() ||
            request.method !== "GET"
          ) {
            response.end("Not Found");
            return;
          }
          try {
            const url = new URL(request.url ?? "/", entry.lease.viewOrigin);
            if (
              request.headers.host !== new URL(entry.lease.viewOrigin).host ||
              url.pathname !== SANDBOX_VIEW_PATH
            ) {
              response.end("Not Found");
              return;
            }
            const claim = openSandboxViewCapability(
              url.searchParams.get("view_token") ?? "",
              entry.lease.viewOrigin,
            );
            if (
              claim.keyHash !== entry.lease.keyHash ||
              claim.identityHash !== entry.lease.identityHash
            ) {
              response.end("Not Found");
              return;
            }
            const document = renderSandboxProxyHtml({
              htmlSha256: entry.lease.htmlHash,
              hostOrigin: entry.lease.hostOrigin,
              admissionId: entry.id,
            });
            response.writeHead(200, sandboxViewHeaders(entry.lease.policy));
            response.end(document);
          } catch {
            // Invalid public capabilities return the same bounded, restrictive document response.
            response.end("Not Found");
          }
        });
        await new Promise<void>((resolve, reject) => {
          server!.once("error", reject);
          server!.listen(this.port, "127.0.0.1", () => {
            server!.removeListener("error", reject);
            resolve();
          });
        });
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("App document listener did not open");
        signal?.throwIfAborted();
        if (this.closing) throw new Error("App document service is closed");
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
          // origin even when the OS reuses a port. The Host check rejects old URLs.
          viewOrigin: `http://${id}.localhost:${address.port}`,
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
        entry = {
          id,
          fingerprint,
          lease,
          server,
          proxyUrl: `${lease.viewOrigin}${SANDBOX_VIEW_PATH}?view_token=${capability}`,
        };
        this.entries.set(id, entry);
        this.viewKeys.set(keyHash, id);
        this.arm(entry);
        return this.response(entry);
      }
    } catch (error) {
      if (server?.listening && !entry) {
        server.closeAllConnections();
        server.close();
      }
      throw error;
    } finally {
      this.reserved--;
      const reserved = (this.reservedOwners.get(ownerHash) ?? 1) - 1;
      if (reserved === 0) this.reservedOwners.delete(ownerHash);
      else this.reservedOwners.set(ownerHash, reserved);
    }
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
    entry.server.closeAllConnections();
    entry.server.close();
  }
  close(): void {
    this.closing = true;
    for (const entry of this.entries.values())
      this.dispose(entry.id, entry.lease.ownerHash);
  }
}
export const sandboxViews = new SandboxViewRegistry();
process.once("exit", () => sandboxViews.close());
