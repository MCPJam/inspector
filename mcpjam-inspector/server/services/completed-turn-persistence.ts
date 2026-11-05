import { abortable } from "./sessionSimulation/target-discovery.js";
import { randomUUID } from "node:crypto";
import type { PersistChatOutcome } from "../utils/chat-ingestion.js";

export const COMPLETED_TURN_RETRY_TTL_MS = 30_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_ACTOR_BYTES = 16 * 1024 * 1024;
const MAX_RECORDS = 16;
const MAX_ACTOR_RECORDS = 2;
export type CompletedTurnOwner = { subject: string; projectId: string };
type RecordEntry = CompletedTurnOwner & {
  body: string;
  bytes: number;
  chatSessionId: string;
  turnId: string;
  busy: boolean;
  closed: boolean;
  result: Promise<PersistChatOutcome>;
  finish: (outcome: PersistChatOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
  controller: AbortController;
};
const unavailable = (): PersistChatOutcome => ({
  outcome: "failed",
  failureKind: "timeout",
});

/** Holds only the already-scrubbed ingest bytes, never execution or credentials. */
export class CompletedTurnPersistence {
  private records = new Map<string, RecordEntry>();

  register(
    owner: CompletedTurnOwner,
    body: string,
    chatSessionId: string,
    turnId: string,
  ): string | undefined {
    const bytes = Buffer.byteLength(body);
    const records = [...this.records.values()];
    const own = records.filter((record) => record.subject === owner.subject);
    if (
      !owner.subject ||
      !owner.projectId ||
      !turnId ||
      bytes > MAX_BODY_BYTES ||
      records.length >= MAX_RECORDS ||
      own.length >= MAX_ACTOR_RECORDS ||
      records.reduce((sum, record) => sum + record.bytes, bytes) >
        MAX_TOTAL_BYTES ||
      own.reduce((sum, record) => sum + record.bytes, bytes) > MAX_ACTOR_BYTES
    )
      return;
    const id = randomUUID();
    const controller = new AbortController();
    let resolve!: (outcome: PersistChatOutcome) => void;
    const result = new Promise<PersistChatOutcome>((done) => {
      resolve = done;
    });
    const finish = (outcome: PersistChatOutcome) => {
      const record = this.records.get(id);
      if (!record || record.closed) return;
      record.closed = true;
      clearTimeout(record.timer);
      controller.abort();
      if (!record.busy) this.records.delete(id);
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish(unavailable()),
      COMPLETED_TURN_RETRY_TTL_MS,
    );
    timer.unref?.();
    this.records.set(id, {
      ...owner,
      body,
      bytes,
      chatSessionId,
      turnId,
      busy: false,
      closed: false,
      result,
      finish,
      timer,
      controller,
    });
    return id;
  }

  wait(id: string): Promise<PersistChatOutcome> {
    return this.records.get(id)?.result ?? Promise.resolve(unavailable());
  }

  cancel(id: string): void {
    this.records.get(id)?.finish(unavailable());
  }

  async retry(
    id: string,
    owner: CompletedTurnOwner & { chatSessionId: string; turnId: string },
    persist: (body: string, signal: AbortSignal) => Promise<PersistChatOutcome>,
  ): Promise<PersistChatOutcome | "missing" | "busy"> {
    const record = this.records.get(id);
    // A guessed handle never changes the rightful owner's wait or claim.
    if (
      !record ||
      record.closed ||
      record.subject !== owner.subject ||
      record.projectId !== owner.projectId ||
      record.chatSessionId !== owner.chatSessionId ||
      record.turnId !== owner.turnId
    )
      return "missing";
    if (record.busy) return "busy";
    record.busy = true;
    const work = Promise.resolve().then(() =>
      persist(record.body, record.controller.signal),
    );
    const settled = () => {
      record.busy = false;
      if (record.closed) this.records.delete(id);
    };
    // A non-cooperative callback remains charged to capacity until it settles.
    void work.then(settled, settled);
    try {
      const outcome = await abortable(work, record.controller.signal);
      record.finish(outcome);
      return outcome;
    } catch (error) {
      if (record.controller.signal.aborted) return unavailable();
      throw error;
    } finally {
      // Includes denied membership or a failed transport. No hidden retry loop.
      record.finish(unavailable());
    }
  }
}

export const completedTurnPersistence = new CompletedTurnPersistence();
