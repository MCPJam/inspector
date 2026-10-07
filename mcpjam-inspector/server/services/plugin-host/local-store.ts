import { HOSTED_MODE } from "../../config.js";
import { PluginInvocationError } from "./invocation.js";
import { hasServiceCredential } from "../service-credential.js";
import {
  isDurableInteractiveFileDescriptor,
  INVOCATION_RECEIPT_RETENTION_MS,
  INVOCATION_RECEIPT_TTL_MS,
  PLUGIN_INSTANCE_CONTEXT_BYTES,
  PLUGIN_INSTANCE_CONTROL_BYTES,
  PLUGIN_INSTANCE_CONTROL_PATH,
} from "../../../shared/plugin-invocation-receipts.js";

/**
 * Single-user local installs (not hosted, no INSPECTOR_SERVICE_TOKEN) keep App
 * instance controls in this process instead of the backend service, with the
 * same request contract and rules (expiry, ownership, activation anchors and
 * renewal, context versions, close tombstones). Invocation receipts stay in
 * the live invoker, as before. Nothing survives a restart: Apps reopen.
 */
export function pluginLocalStoresEnabled(
  env: NodeJS.ProcessEnv = process.env,
  hosted: boolean = HOSTED_MODE,
) {
  return !hosted && !hasServiceCredential(env);
}

const fail = (code: string): never => {
  throw new PluginInvocationError(code);
};
const hash = (value: unknown) => {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    fail("INVALID_INSTANCE_CONTROL");
};
const bytes = (value: string) => Buffer.byteLength(value);

type ControlRow = {
  controlHash: string;
  identityHash: string;
  ownerHash?: string;
  snapshotJson?: string;
  expiresAt: number;
  pruneAt: number;
  closed: boolean;
  activationToken?: string;
  activationAnchorHash?: string;
  activationBindingHash?: string;
  activationRenewable?: boolean;
  contextToken?: string;
  contextVersion?: number;
  contextJson?: string;
};
export class LocalPluginControlStore {
  private readonly controls = new Map<string, ControlRow>();
  private readonly anchors = new Map<string, string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  /** A `createPluginServiceStore`-compatible request handler for `path`. */
  handler(path: string, unavailable: string) {
    return async (body: unknown, signal: AbortSignal): Promise<any> => {
      signal.throwIfAborted();
      this.prune();
      // Same envelope as the HTTP service: plain JSON in and out.
      const command = JSON.parse(JSON.stringify(body)) as Record<
        string,
        any
      >;
      if (path === PLUGIN_INSTANCE_CONTROL_PATH) return this.control(command);
      return fail(unavailable);
    };
  }

  private view(row: ControlRow) {
    return {
      snapshotJson: row.snapshotJson!,
      expiresAt: row.expiresAt,
      ...(row.contextToken ? { contextVersion: row.contextVersion ?? 0 } : {}),
      ...(row.contextJson ? { contextJson: row.contextJson } : {}),
    };
  }

  private live(row: ControlRow | undefined, identityHash: string) {
    if (!row) return undefined;
    if (row.identityHash !== identityHash) fail("INSTANCE_DENIED");
    if (row.closed || row.expiresAt <= this.now()) fail("INSTANCE_UNAVAILABLE");
    return row;
  }

  private control(c: Record<string, any>) {
    hash(c.identityHash);
    const now = this.now();
    if (c.action === "read-activation") {
      hash(c.activationAnchorHash);
      const controlHash = this.anchors.get(c.activationAnchorHash);
      const row = controlHash ? this.controls.get(controlHash) : undefined;
      if (!row) return { activation: null };
      if (row.identityHash !== c.identityHash) fail("INSTANCE_DENIED");
      if (row.closed || row.expiresAt <= now) {
        if (!row.activationRenewable) fail("INSTANCE_UNAVAILABLE");
        return { activation: null };
      }
      if (row.activationBindingHash !== c.activationBindingHash)
        fail("ACTIVATION_BINDING_CHANGED");
      return {
        activation: { token: row.activationToken!, control: this.view(row) },
      };
    }
    if (c.action === "list-contexts")
      return {
        tokens: [...this.controls.values()]
          .filter(
            (row) =>
              row.identityHash === c.identityHash &&
              !row.closed &&
              row.expiresAt > now &&
              row.contextToken,
          )
          .slice(0, 64)
          .map((row) => row.contextToken!),
      };
    if (c.action === "list-models") return { tokens: [] };
    hash(c.controlHash);
    const row = this.controls.get(c.controlHash);
    if (row && row.identityHash !== c.identityHash) fail("INSTANCE_DENIED");
    if (c.action === "read") {
      if (!row) return { control: null };
      this.live(row, c.identityHash);
      return { control: this.view(row) };
    }
    if (c.action === "close") {
      if (row) {
        Object.assign(row, {
          closed: true,
          snapshotJson: undefined,
          activationToken: undefined,
          contextToken: undefined,
          contextJson: undefined,
          contextVersion: undefined,
        });
        if (row.activationAnchorHash)
          this.anchors.delete(row.activationAnchorHash);
        row.activationAnchorHash = undefined;
      } else if (c.reserveUnknown) {
        this.controls.set(c.controlHash, {
          controlHash: c.controlHash,
          identityHash: c.identityHash,
          closed: true,
          expiresAt: now + INVOCATION_RECEIPT_TTL_MS,
          pruneAt: now + INVOCATION_RECEIPT_RETENTION_MS,
        });
      }
      return { closed: true, ...(row?.ownerHash ? { ownerHash: row.ownerHash } : {}) };
    }
    if (c.action === "context") {
      if (!row || row.closed || row.expiresAt <= now || !row.contextToken)
        fail("INSTANCE_UNAVAILABLE");
      if (
        !Number.isSafeInteger(c.expectedVersion) ||
        c.expectedVersion < 0 ||
        typeof c.contextJson !== "string" ||
        bytes(c.contextJson) > PLUGIN_INSTANCE_CONTEXT_BYTES
      )
        fail("INVALID_INSTANCE_CONTEXT");
      const version = row!.contextVersion ?? 0;
      if (version === c.expectedVersion + 1 && row!.contextJson === c.contextJson)
        return { control: this.view(row!) };
      if (version !== c.expectedVersion) fail("INSTANCE_CONTEXT_CONFLICT");
      // No lifetime ceiling: versions only need to stay monotonic.
      row!.contextVersion = version + 1;
      row!.contextJson = c.contextJson;
      return { control: this.view(row!) };
    }
    if (c.action === "renew") {
      if (
        !row ||
        row.closed ||
        row.expiresAt <= now ||
        !row.activationAnchorHash
      )
        fail("INSTANCE_UNAVAILABLE");
      if (
        !Number.isSafeInteger(c.expiresAt) ||
        c.expiresAt <= row!.expiresAt ||
        c.expiresAt > now + INVOCATION_RECEIPT_TTL_MS
      )
        fail("INVALID_INSTANCE_CONTROL");
      // Same rules as the backend: unattended runs keep their fixed deadline,
      // and a lease never outlives the host-selected bytes an interactive file
      // viewer was opened with.
      let snapshot: { kind?: unknown; instance?: { activation?: { file?: unknown } } };
      try {
        snapshot = JSON.parse(row!.snapshotJson ?? "null") ?? {};
      } catch {
        return fail("INVALID_INSTANCE_CONTROL");
      }
      const declaration = snapshot.instance?.activation;
      if (
        snapshot.kind ||
        !declaration ||
        (isDurableInteractiveFileDescriptor(declaration.file) &&
          c.expiresAt > declaration.file.ownership.expiresAt)
      )
        fail("INVALID_INSTANCE_CONTROL");
      row!.expiresAt = c.expiresAt;
      row!.pruneAt = Math.max(
        row!.pruneAt,
        c.expiresAt + INVOCATION_RECEIPT_RETENTION_MS,
      );
      return { control: this.view(row!) };
    }
    if (c.action !== "issue") return fail("INSTANCE_STORE_UNAVAILABLE");
    hash(c.ownerHash);
    if (
      !Number.isSafeInteger(c.expiresAt) ||
      c.expiresAt <= now ||
      c.expiresAt > now + INVOCATION_RECEIPT_TTL_MS ||
      typeof c.snapshotJson !== "string" ||
      bytes(c.snapshotJson) > PLUGIN_INSTANCE_CONTROL_BYTES
    )
      fail("INVALID_INSTANCE_CONTROL");
    if (c.contextToken !== undefined && !/^[A-Za-z0-9_-]{43}$/.test(c.contextToken))
      fail("INVALID_INSTANCE_CONTROL");
    const activation = c.activation as
      | { token: string; anchorHash: string; bindingHash: string; renewable: boolean }
      | undefined;
    if (activation) {
      hash(activation.anchorHash);
      hash(activation.bindingHash);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(activation.token) ||
        (c.contextToken && c.contextToken !== activation.token)
      )
        fail("INVALID_INSTANCE_CONTROL");
      const originalHash = this.anchors.get(activation.anchorHash);
      const original = originalHash
        ? this.controls.get(originalHash)
        : undefined;
      if (original) {
        if (original.identityHash !== c.identityHash) fail("INSTANCE_DENIED");
        if (!original.closed && original.expiresAt > now) {
          if (
            original.activationBindingHash !== activation.bindingHash ||
            original.activationRenewable !== activation.renewable
          )
            fail("ACTIVATION_BINDING_CHANGED");
          return {
            token: original.activationToken!,
            control: this.view(original),
          };
        }
        if (!original.activationRenewable || !activation.renewable)
          fail("INSTANCE_UNAVAILABLE");
        this.anchors.delete(activation.anchorHash);
        original.activationAnchorHash = undefined;
      }
    }
    if (row) {
      this.live(row, c.identityHash);
      if (
        row.ownerHash !== c.ownerHash ||
        row.snapshotJson !== c.snapshotJson ||
        row.expiresAt !== c.expiresAt
      )
        fail("INSTANCE_CONTROL_CHANGED");
    } else {
      if (
        [...this.controls.values()].some((other) => other.ownerHash === c.ownerHash)
      )
        fail("INSTANCE_CONTROL_CHANGED");
      if (
        [...this.controls.values()].filter(
          (other) =>
            other.identityHash === c.identityHash &&
            !other.closed &&
            other.expiresAt > now,
        ).length >= 512
      )
        fail("INSTANCE_LIMIT");
      const inserted: ControlRow = {
        controlHash: c.controlHash,
        identityHash: c.identityHash,
        ownerHash: c.ownerHash,
        snapshotJson: c.snapshotJson,
        expiresAt: c.expiresAt,
        pruneAt: now + INVOCATION_RECEIPT_RETENTION_MS,
        closed: false,
        ...(activation
          ? {
              activationToken: activation.token,
              activationAnchorHash: activation.anchorHash,
              activationBindingHash: activation.bindingHash,
              activationRenewable: activation.renewable,
            }
          : {}),
        ...(c.contextToken
          ? { contextToken: c.contextToken, contextVersion: 0 }
          : {}),
      };
      this.controls.set(c.controlHash, inserted);
      if (activation) this.anchors.set(activation.anchorHash, c.controlHash);
    }
    const current = this.controls.get(c.controlHash)!;
    return {
      ...(activation ? { token: activation.token } : {}),
      control: this.view(current),
    };
  }

  private lastPrune = 0;
  private prune() {
    const now = this.now();
    if (now - this.lastPrune < 60_000) return;
    this.lastPrune = now;
    for (const [key, row] of this.controls)
      if (row.pruneAt <= now) {
        this.controls.delete(key);
        if (row.activationAnchorHash) this.anchors.delete(row.activationAnchorHash);
      }
  }
}

export const localPluginControls = new LocalPluginControlStore();
