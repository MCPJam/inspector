/**
 * The mock's task store, over the backend (`mockTasks:*`, B7): the one place
 * the Inspector names those functions. A task created on one replica is read
 * and updated on another because every read and write goes to the backend and
 * nothing is kept here.
 *
 * Records cross as JSON text (Convex rejects some keys a result may hold). The
 * backend scopes tasks to the caller and the mock, and matches `owner` on
 * every read, so another owner's task reads as absent.
 */
import { makeFunctionReference } from "convex/server";
import type { MockTaskPatch, MockTaskRecord, MockTaskStore } from "@mcpjam/sdk/mocks";
import { createConvexClient } from "../../routes/v1/convex-client.js";

const fn = {
  create: makeFunctionReference<"mutation">("mockTasks:create"),
  get: makeFunctionReference<"query">("mockTasks:get"),
  list: makeFunctionReference<"query">("mockTasks:list"),
  update: makeFunctionReference<"mutation">("mockTasks:update"),
};

type Recorded = { recordJson: string } | null;

const parseRecord = (json: string): MockTaskRecord => JSON.parse(json) as MockTaskRecord;

/** `token` is a Convex bearer for the caller; it is read for each call, so a renewed one is picked up. */
export function backendTaskStore(token: () => Promise<string>, mockId: string): MockTaskStore {
  const client = async () => createConvexClient(await token());
  return {
    create: async (record) => {
      await (await client()).mutation(fn.create, { mockId, recordJson: JSON.stringify(record) });
    },
    get: async (owner, taskId) => {
      const found = (await (await client()).query(fn.get, { mockId, owner, taskId })) as Recorded;
      return found ? parseRecord(found.recordJson) : undefined;
    },
    list: async (owner) => {
      const { recordsJson } = (await (await client()).query(fn.list, { mockId, owner })) as {
        recordsJson: string;
      };
      return (JSON.parse(recordsJson) as MockTaskRecord[]) ?? [];
    },
    update: async (owner, taskId, patch: MockTaskPatch) => {
      const updated = (await (await client()).mutation(fn.update, {
        mockId,
        owner,
        taskId,
        patchJson: JSON.stringify(patch),
      })) as Recorded;
      return updated ? parseRecord(updated.recordJson) : undefined;
    },
  };
}
