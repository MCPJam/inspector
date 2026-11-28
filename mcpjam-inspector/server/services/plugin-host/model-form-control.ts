import { randomBytes } from "node:crypto";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import {
  INVOCATION_RECEIPT_TTL_MS,
  PLUGIN_INSTANCE_CONTROL_BYTES,
  type DurablePluginInstanceControl,
} from "../../../shared/plugin-invocation-receipts.js";
import { pluginBindingDigest, pluginServerIdentitySchema } from "./bindings.js";
import { DurableControlCache, type CachedControl } from "./durable-controls.js";
import { pluginControlOwnerHash } from "./form-source-control.js";
import {
  pluginInstances,
  type PluginFormOwner,
  type PluginInstanceIdentity,
} from "./instances.js";
import {
  PluginInvocationError,
  type PluginToolCallParams,
} from "./invocation.js";
import {
  createPluginInstanceControlPort,
  type PluginInstanceControlPort,
} from "./instance-store.js";
import { pluginLocalStoresEnabled } from "./local-store.js";
import { RequestOwnedToolInvoker } from "./request-invoker.js";

/** A minute under the store's ceiling, so a replica whose clock runs a little
 * ahead of the store's still issues the row. */
const MODEL_FORM_TTL_MS = INVOCATION_RECEIPT_TTL_MS - 60_000;
const id = z.string().min(1).max(4096);
const isCode = (error: unknown, ...codes: string[]) =>
  error instanceof PluginInvocationError && codes.includes(error.code);
const denied = () => new PluginInvocationError("MODEL_FORM_UNAVAILABLE");

/**
 * A model call suspended on a form: data only, so any replica can take the
 * answer. The pending round is not here; the call's receipt and its MRTR
 * continuation hold it. No credential, connection or callback is stored.
 */
const modelFormControlSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("model-form"),
  expiresAt: z.number().int().positive(),
  instance: z.strictObject({
    owner: z.strictObject({
      actorId: id,
      projectId: id,
      workspaceId: id,
      instanceId: id,
      generation: z.literal(1),
      serverId: id,
      bindingId: id,
      placement: z.literal("interactive"),
    }),
    hostId: id,
    hostRevision: id,
    serverIdentity: pluginServerIdentitySchema,
  }),
  toolCallId: z.string().min(1).max(128),
  revision: id,
  params: z.looseObject({ name: id }),
});
type ModelFormSnapshot = z.infer<typeof modelFormControlSchema>;

/** This process's copy of a suspended model call's form. */
export interface ModelForm extends CachedControl {
  readonly token: string;
  readonly instance: PluginFormOwner;
  readonly identity: PluginInstanceIdentity;
  readonly params: PluginToolCallParams;
  readonly toolCallId: string;
  readonly revision: string;
  readonly invoker: RequestOwnedToolInvoker;
  readonly snapshotJson: string;
  /** Whether its row is in the store, so other replicas can restore it. */
  stored: boolean;
  release: () => void;
}

const sameIdentity = (a: PluginInstanceIdentity, b: PluginInstanceIdentity) =>
  a.actorId === b.actorId &&
  a.projectId === b.projectId &&
  a.workspaceId === b.workspaceId &&
  a.subject === b.subject;

/** The model owner forms find while this copy lives. A copy restored next
 * to one this process began for the same call shares that one's lifetime. */
function retainOwner(instance: PluginFormOwner, signal: AbortSignal) {
  try {
    return pluginInstances.retainModelOwner(instance, signal);
  } catch (error) {
    if (!isCode(error, "INSTANCE_ALREADY_OWNED")) throw error;
    return () => {};
  }
}

/**
 * Suspended model calls. A call that opens a form writes its row first
 * (`store`), and any replica that receives the answer restores it through the
 * shared durable-control cache. Every acting request reads the row; this
 * process's copy only saves rebuilding the invoker.
 */
export class ModelFormRegistry {
  private readonly controls: DurableControlCache<ModelForm, ModelFormSnapshot>;
  constructor(
    private readonly ttlMs = MODEL_FORM_TTL_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly portFor: (
      identity: PluginInstanceIdentity,
    ) =>
      PluginInstanceControlPort | undefined = createPluginInstanceControlPort,
    private readonly hosted: () => boolean = () => !pluginLocalStoresEnabled(),
  ) {
    this.controls = new DurableControlCache<ModelForm, ModelFormSnapshot>(
      {
        denied,
        parse: (saved) => this.parse(saved),
        issuedUntil: (snapshot) => snapshot.expiresAt,
        owns: (snapshot, actor) =>
          snapshot.instance.owner.actorId === actor.actorId &&
          snapshot.instance.owner.projectId === actor.projectId &&
          snapshot.instance.owner.workspaceId === actor.workspaceId,
        matches: (form, actor) => sameIdentity(form.identity, actor),
        create: ({ token, actor, snapshot, saved, assertLive }) =>
          this.build(token, actor, snapshot, saved.snapshotJson, true, assertLive),
        release: (form) => form.release(),
      },
      { ttlMs, now, portFor },
    );
  }

  private parse(saved: DurablePluginInstanceControl) {
    try {
      const parsed = modelFormControlSchema.safeParse(
        JSON.parse(saved.snapshotJson),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      // A row that is not JSON is no model form.
      return undefined;
    }
  }

  private build(
    token: string,
    identity: PluginInstanceIdentity,
    snapshot: ModelFormSnapshot,
    snapshotJson: string,
    stored: boolean,
    assertLive: () => void,
  ): ModelForm {
    const instance: PluginFormOwner = {
      ...snapshot.instance,
      subject: identity.subject,
    };
    const abort = new AbortController();
    const owner = retainOwner(instance, abort.signal);
    const invoker = new RequestOwnedToolInvoker(instance.owner, () => {
      assertLive();
      pluginInstances.getFormOwner(instance.owner, identity);
    });
    let released = false;
    return {
      token,
      instance,
      identity: structuredClone(identity),
      params: snapshot.params as PluginToolCallParams,
      toolCallId: snapshot.toolCallId,
      revision: snapshot.revision,
      invoker,
      snapshotJson,
      snapshotHash: pluginBindingDigest(snapshotJson),
      expiresAt: snapshot.expiresAt,
      abort,
      stored,
      release: () => {
        if (released) return;
        released = true;
        abort.abort();
        invoker.close();
        owner();
      },
    };
  }

  /** A gated model call that may open a form. Nothing is stored unless it
   * does (`store`). */
  begin(input: {
    instance: PluginFormOwner;
    identity: PluginInstanceIdentity;
    params: PluginToolCallParams;
    toolCallId: string;
    revision: string;
  }) {
    const token = randomBytes(32).toString("base64url");
    const { owner, hostId, hostRevision, serverIdentity } = input.instance;
    const snapshot = modelFormControlSchema.parse({
      version: 1,
      kind: "model-form",
      expiresAt: this.now() + this.ttlMs,
      instance: { owner, hostId, hostRevision, serverIdentity },
      toolCallId: input.toolCallId,
      revision: input.revision,
      params: input.params,
    });
    let form: ModelForm | undefined;
    form = this.build(
      token,
      input.identity,
      snapshot,
      JSON.stringify(snapshot),
      false,
      () => {
        if (!form || form.abort.signal.aborted || form.expiresAt <= this.now())
          throw denied();
        if (form.stored) this.controls.get(token, input.identity);
      },
    );
    return form;
  }

  /** Store the row before the form reaches the browser. Refused when the
   * hosted store can't take it; this process never stands in for the store. */
  async store(form: ModelForm, signal: AbortSignal) {
    if (form.stored) return;
    const bytes = Buffer.byteLength(form.snapshotJson);
    const notSaved = () => new PluginInvocationError("FORM_NOT_SAVED");
    if (this.hosted() && bytes > PLUGIN_INSTANCE_CONTROL_BYTES) {
      logger.warn("Model form not shown: its record is too large to store", {
        bytes,
      });
      throw notSaved();
    }
    const port = this.portFor(form.identity);
    if (!port) throw notSaved();
    try {
      await port.issue(
        form.token,
        {
          snapshotJson: form.snapshotJson,
          ownerHash: pluginControlOwnerHash(
            "model-form",
            form.identity,
            form.token,
          ),
          expiresAt: form.expiresAt,
        },
        signal,
      );
    } catch (error) {
      logger.warn("Model form not shown: its record was not stored", {
        code: error instanceof PluginInvocationError ? error.code : undefined,
      });
      throw notSaved();
    }
    form.stored = true;
    this.controls.adopt(form.token, form);
  }

  /** The stored form, restored into this process for this caller. */
  async restore(
    token: string,
    identity: PluginInstanceIdentity,
    signal: AbortSignal,
  ) {
    try {
      return await this.controls.restore(token, identity, signal);
    } catch (error) {
      if (isCode(error, "INSTANCE_STORE_UNAVAILABLE"))
        throw new PluginInvocationError("FORM_STORE_UNAVAILABLE");
      throw error;
    }
  }

  get(token: string, identity: PluginInstanceIdentity) {
    return this.controls.get(token, identity);
  }

  /** Admission read, then the stored row (see `DurableControlCache.fence`). */
  fence(token: string, identity: PluginInstanceIdentity, signal: AbortSignal) {
    return this.controls.fence(token, identity, signal);
  }
}
export const pluginModelForms = new ModelFormRegistry();
