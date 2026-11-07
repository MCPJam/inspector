import { abortable } from "./sessionSimulation/target-discovery.js";
import { decodeJwt } from "jose";
import { randomUUID } from "node:crypto";
import type { UIMessageChunk } from "ai";
import { MAX_TURN_AUTHORIZATION_MS, turnAuthorizationIdentity, type TurnAuthorizationIdentity } from "../../shared/turn-authorization.js";
import { verifyAuthKitToken } from "./authkit-jwt.js";
import { assertSessionServable } from "../middleware/session-revocation.js";
import { ErrorCode, WebRouteError } from "../routes/web/errors.js";

const MAX_AGE_MS = MAX_TURN_AUTHORIZATION_MS;
const MAX_TOKEN_BYTES = 32 * 1024;
export interface TurnAuthorizationOwner {
  subject: string;
  sessionId: string;
  organizationId?: string;
}
export interface TurnAuthorization {
  start(turnId: string, writer: { write(chunk: UIMessageChunk): void }): void;
  getAuthorization(): Promise<string>;
  /** Terminal cleanup may verify the last token after active renewal was revoked. */
  getCleanupAuthorization(): Promise<string>;
  dispose(): void;
}
interface Entry {
  identity: TurnAuthorizationIdentity;
  owner: TurnAuthorizationOwner;
  token: string;
  expiresAt: number;
  renewable: boolean;
  waiters: Set<() => void>;
  timer: ReturnType<typeof setTimeout>;
}
const refused = () => new WebRouteError(401, ErrorCode.UNAUTHORIZED,
  "This turn can no longer renew its authorization. Sign in and start a new turn.");

/** Credentials stay in this process only for the original, still-running turn. */
export class TurnAuthorizationRegistry {
  private tokenExpiresAt(entry: Entry) {
    const exp = decodeJwt(entry.token).exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) throw refused();
    return Math.min(exp * 1000, entry.expiresAt);
  }
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly verifyToken = verifyAuthKitToken) {}

  create(owner: TurnAuthorizationOwner, scope: Omit<TurnAuthorizationIdentity, "handle">,
    token: string, signal?: AbortSignal) {
    if (token.length > MAX_TOKEN_BYTES || this.entries.size >= 64 ||
      [...this.entries.values()].filter((e) => e.owner.subject === owner.subject).length >= 8)
      throw new WebRouteError(429, ErrorCode.RATE_LIMITED, "Too many active turns. Wait for a turn to finish.");
    const handle = randomUUID();
    const identity = turnAuthorizationIdentity.parse({ ...scope, handle });
    const expiresAt = Date.now() + MAX_AGE_MS;
    const dispose = () => {
      const entry = this.entries.get(handle);
      if (entry) { clearTimeout(entry.timer); this.wake(entry); }
      this.entries.delete(handle);
      signal?.removeEventListener("abort", stopRenewal);
    };
    const stopRenewal = () => {
      const entry = this.entries.get(handle);
      if (entry) { entry.renewable = false; this.wake(entry); }
    };
    const timer = setTimeout(dispose, MAX_AGE_MS);
    timer.unref?.();
    const entry: Entry = { identity, owner, token, expiresAt,
      renewable: !signal?.aborted, waiters: new Set(), timer };
    this.entries.set(handle, entry);
    signal?.addEventListener("abort", stopRenewal, { once: true });
    return {
      data: { ...entry.identity, expiresAt, tokenExpiresAt: this.tokenExpiresAt(entry) },
      dispose,
      getCleanupAuthorization: async () => {
        const token = entry.token;
        await abortable(this.verify(token, owner), AbortSignal.timeout(10_000));
        return `Bearer ${token}`;
      },
      getAuthorization: async () => {
        if (this.entries.get(handle) !== entry || !entry.renewable || Date.now() >= expiresAt) throw refused();
        if (this.tokenExpiresAt(entry) <= Date.now() + 30_000) {
          let wake = () => {};
          try {
            await abortable(new Promise<void>((resolve) => {
              wake = resolve;
              entry.waiters.add(wake);
            }), AbortSignal.timeout(15_000));
          } finally { entry.waiters.delete(wake); }
        }
        if (this.entries.get(handle) !== entry || !entry.renewable || Date.now() >= expiresAt) throw refused();
        const token = entry.token;
        await abortable(this.verify(token, owner), AbortSignal.timeout(10_000));
        if (this.entries.get(handle) !== entry || !entry.renewable || Date.now() >= expiresAt) throw refused();
        return `Bearer ${token}`;
      },
    };
  }

  private wake(entry: Entry) {
    for (const resolve of entry.waiters) resolve();
    entry.waiters.clear();
  }

  private async verify(token: string, owner: TurnAuthorizationOwner) {
    const verified = await this.verifyToken(token, undefined, { allowMcpResourceAudience: true });
    if (verified.sub !== owner.subject || verified.sid !== owner.sessionId || verified.orgId !== owner.organizationId) throw refused();
    assertSessionServable(verified.sid, { requireFresh: true, path: "/api/mcp/turn-authorization" });
  }

  async renew(identity: TurnAuthorizationIdentity, owner: TurnAuthorizationOwner, token: string) {
    const entry = this.entries.get(identity.handle);
    if (!entry || !entry.renewable || Date.now() >= entry.expiresAt ||
      entry.owner.subject !== owner.subject || entry.owner.sessionId !== owner.sessionId ||
      entry.owner.organizationId !== owner.organizationId ||
      identity.projectId !== entry.identity.projectId || identity.chatSessionId !== entry.identity.chatSessionId ||
      identity.turnId !== entry.identity.turnId || identity.requestId !== entry.identity.requestId) throw refused();
    if (token.length > MAX_TOKEN_BYTES) throw refused();
    await this.verify(token, owner);
    if (this.entries.get(identity.handle) !== entry || !entry.renewable || Date.now() >= entry.expiresAt) throw refused();
    const expires = decodeJwt(token).exp;
    if (typeof expires !== "number" || !Number.isFinite(expires)) throw refused();
    if (expires * 1000 >= this.tokenExpiresAt(entry) && token !== entry.token) {
      entry.token = token;
      this.wake(entry);
    }
    return { tokenExpiresAt: this.tokenExpiresAt(entry) };
  }
}
export const turnAuthorizations = new TurnAuthorizationRegistry();
