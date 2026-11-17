import { randomBytes } from "node:crypto";
import { PLUGIN_MESSAGE_PREPARATION_MS } from "../../../shared/plugin-message.js";
import { PluginInvocationError } from "./invocation.js";

export type MessagePreparation = {
  actorId: string;
  projectId: string;
  subject: string;
  hostId: string;
  serverId: string;
  toolName: string;
  revision: string;
  intentDigest: string;
};
/** What a reader must present: every field is compared with the prepared one.
 * No workspace: the new chat may open in another workspace of the project. */
export type MessagePreparationIdentity = Pick<
  MessagePreparation,
  "actorId" | "projectId" | "subject" | "hostId" | "intentDigest"
>;
/** Short-lived transfer authority, issued only after original source admission.
 * No content, credentials, runtime closures, or execution receipts are retained.
 * A preparation lives `PLUGIN_MESSAGE_PREPARATION_MS`, reads only for its own
 * identity, and binds to one destination: a second destination is refused,
 * the same one may bind again.
 */
export interface MessagePreparationStore {
  issue(value: MessagePreparation, signal: AbortSignal): Promise<string>;
  read(
    token: string,
    identity: MessagePreparationIdentity,
    signal: AbortSignal,
  ): Promise<MessagePreparation>;
  bind(
    token: string,
    identity: MessagePreparationIdentity,
    destination: string,
    signal: AbortSignal,
  ): Promise<void>;
}
const unavailable = () =>
  new PluginInvocationError("INSTANCE_MESSAGE_UNAVAILABLE");
/** The single-process store, for local installs only: hosted replicas share
 * the durable one in `message-preparation-store.ts`. */
export class MessagePreparations implements MessagePreparationStore {
  private records = new Map<
    string,
    MessagePreparation & { expires: number; destination?: string }
  >();
  constructor(private now = Date.now) {}
  async issue(value: MessagePreparation) {
    for (const [token, record] of this.records)
      if (record.expires <= this.now()) this.records.delete(token);
    for (const [token, record] of this.records)
      if (
        Object.entries(value).every(
          ([key, item]) => record[key as keyof MessagePreparation] === item,
        )
      )
        return token;
    if (this.records.size >= 512)
      throw new PluginInvocationError("INSTANCE_MESSAGE_LIMIT");
    const token = randomBytes(32).toString("base64url");
    this.records.set(token, {
      ...value,
      expires: this.now() + PLUGIN_MESSAGE_PREPARATION_MS,
    });
    return token;
  }
  private live(token: string, identity: MessagePreparationIdentity) {
    const record = this.records.get(token);
    if (
      !record ||
      record.expires <= this.now() ||
      Object.entries(identity).some(
        ([key, value]) => record[key as keyof MessagePreparation] !== value,
      )
    )
      throw unavailable();
    return record;
  }
  async read(token: string, identity: MessagePreparationIdentity) {
    const {
      expires: _expires,
      destination: _destination,
      ...record
    } = this.live(token, identity);
    return record;
  }
  async bind(
    token: string,
    identity: MessagePreparationIdentity,
    destination: string,
  ) {
    const record = this.live(token, identity);
    if (record.destination && record.destination !== destination)
      throw unavailable();
    record.destination = destination;
  }
}
export const messagePreparations = new MessagePreparations();
