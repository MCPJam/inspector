import {
  createLocalFileTargetAdapter,
  type LocalFileTarget,
} from "./local-file-target.js";
import {
  createComputerFileTargetAdapter,
  PluginComputerUnavailableError,
  type ComputerFileSystem,
} from "./computer-file-target.js";
import type { PluginFileTargetPlacement } from "./file-targets.js";
import { HOSTED_MODE } from "../../config.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { PluginPreviewInstance } from "./instances.js";
import { createPluginFileResourceSession } from "./file-resource-session.js";
import { ResourceGrantError, type ResourceVersion } from "./resource-grants.js";

export interface OwnedFileDescriptor {
  uri: string;
  name: string;
}
interface RequestPorts {
  identity: string;
  authorize(signal: AbortSignal): Promise<void>;
  read(uri: string, signal: AbortSignal): Promise<ResourceVersion>;
  /** This request's connection to the project's Computer (hosted file
   * targets). Never retained by the session. */
  computer?: (signal: AbortSignal) => Promise<ComputerFileSystem>;
}
export type PluginFileTargetPlacementOf = () => PluginFileTargetPlacement;
const identity = (instance: PluginPreviewInstance) =>
  JSON.stringify([instance.owner, instance.subject]);
type Session = ReturnType<typeof createPluginFileResourceSession>;

/** Retained file grants keep identity and data-only descriptors, never request credentials. */
export class OwnedFileResources {
  private readonly ports = new AsyncLocalStorage<RequestPorts>();
  /** Hosted MCPJam keeps file targets on the project's Computer; a local
   * install reads its own disk. */
  constructor(
    private readonly placement: PluginFileTargetPlacementOf = () =>
      HOSTED_MODE ? "computer" : "local",
  ) {}
  private readonly sessions = new Map<
    string,
    { identity: string; session: Session }
  >();

  private current(instance: PluginPreviewInstance) {
    const ports = this.ports.getStore();
    if (!ports || ports.identity !== identity(instance))
      throw new ResourceGrantError("RESOURCE_DENIED");
    return ports;
  }

  /**
   * The instance's file grant. A live grant is returned as is; renewal
   * (`renew`) keeps a writable one alive for as long as its owner renews.
   * Every grant for an instance has the same URI (derived from its owner and
   * file), so when one is lost (a restart, or a lapsed or refused renewal)
   * a new grant bound to the same instance replaces it in place and the
   * open App keeps its URI. Nothing volatile carries over: a replaced
   * writable grant refuses writes until the App reads the file again.
   * `opened` marks the activation's own first grant.
   */
  get(
    instance: PluginPreviewInstance,
    signal: AbortSignal,
    options: { opened?: boolean } = {},
  ): Session {
    const descriptor = instance.activation.file;
    if (!descriptor) throw new ResourceGrantError("RESOURCE_DENIED");
    const key = instance.owner.instanceId;
    const ownerIdentity = identity(instance);
    const existing = this.sessions.get(key);
    if (existing) {
      if (existing.identity !== ownerIdentity)
        throw new ResourceGrantError("RESOURCE_DENIED");
      if (existing.session.live) return existing.session;
      this.sessions.delete(key);
      existing.session.close();
    }
    const session = createPluginFileResourceSession({
      owner: { ...instance.owner, subject: instance.subject },
      signal,
      assertLive: () => signal.throwIfAborted(),
      authorize: (active) => this.current(instance).authorize(active),
      // One stable public identity per owner and file. Write receipts and
      // watches stay volatile: a replacement grant starts without them.
      resourceId: createHash("sha256")
        .update(ownerIdentity)
        .update(JSON.stringify(descriptor))
        .digest("hex"),
      ...(descriptor.localTarget
        ? {
            stableIdentity: true,
            reissued: !!existing || options.opened !== true,
          }
        : {}),
      resource: {
        key: descriptor.uri,
        name: descriptor.name,
        maxBytes: 1024 * 1024,
        ...(descriptor.localTarget
          ? {
              // On the Computer this is the VM path the server's own tools use.
              privatePath: `${descriptor.localTarget.root}/${descriptor.localTarget.relativePath}`,
              authorizeWrite: (active: AbortSignal) =>
                this.current(instance).authorize(active),
            }
          : {}),
        adapter: descriptor.localTarget
          ? this.targetAdapter(instance, descriptor.localTarget)
          : {
              read: (_key, active) =>
                this.current(instance).read(descriptor.uri, active),
            },
      },
    });
    this.sessions.set(key, { identity: ownerIdentity, session });
    signal.addEventListener(
      "abort",
      () => {
        if (this.sessions.get(key)?.session === session)
          this.sessions.delete(key);
        session.close();
      },
      { once: true },
    );
    return session;
  }

  /**
   * Renew a retained file viewer's grant with its lease, within `run`:
   * the live grant is extended in place (same URI, same writable state and
   * ETag semantics), or, when it was lost, replaced in place by a new grant
   * bound to the same instance. Throws when the target, the toggles or the
   * actor no longer allow the file; the grant then lapses at its deadline.
   */
  renew(instance: PluginPreviewInstance, lifetime: AbortSignal, signal: AbortSignal) {
    this.current(instance);
    return this.get(instance, lifetime).renew(signal);
  }

  /** The adapter for an admitted file target at this deployment's placement. */
  targetAdapter(instance: PluginPreviewInstance, target: LocalFileTarget) {
    return this.placement() === "computer"
      ? createComputerFileTargetAdapter(target, (signal) => {
          const connect = this.current(instance).computer;
          if (!connect)
            throw new PluginComputerUnavailableError(instance.owner.serverId);
          return connect(signal);
        })
      : createLocalFileTargetAdapter(target);
  }

  run<T>(
    instance: PluginPreviewInstance,
    ports: Omit<RequestPorts, "identity">,
    effect: () => Promise<T>,
  ): Promise<T> {
    return this.ports.run({ ...ports, identity: identity(instance) }, effect);
  }
}
export const ownedFileResources = new OwnedFileResources();
