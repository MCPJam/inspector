import { randomBytes } from "node:crypto";
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
/** Short-lived transfer authority, issued only after original source admission.
 * No content, credentials, runtime closures, or execution receipts are retained.
 */
export class MessagePreparations {
  private records = new Map<
    string,
    MessagePreparation & { expires: number; destination?: string }
  >();
  constructor(private now = Date.now) {}
  issue(value: MessagePreparation) {
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
    this.records.set(token, { ...value, expires: this.now() + 60_000 });
    return token;
  }
  read(
    token: string,
    identity: Pick<
      MessagePreparation,
      "actorId" | "projectId" | "subject" | "hostId" | "intentDigest"
    >,
  ) {
    const record = this.records.get(token);
    if (
      !record ||
      record.expires <= this.now() ||
      Object.entries(identity).some(
        ([key, value]) => record[key as keyof MessagePreparation] !== value,
      )
    )
      throw new PluginInvocationError("INSTANCE_MESSAGE_UNAVAILABLE");
    return { ...record };
  }
  bind(token: string, destination: string) {
    const record = this.records.get(token);
    if (
      !record ||
      record.expires <= this.now() ||
      (record.destination && record.destination !== destination)
    )
      throw new PluginInvocationError("INSTANCE_MESSAGE_UNAVAILABLE");
    record.destination = destination;
  }
}
export const messagePreparations = new MessagePreparations();
