import type {
  MockTaskPatch,
  MockTaskRecord,
  MockTaskStore,
} from "../mock-tasks.js";

const TERMINAL = ["completed", "failed", "cancelled"];

/**
 * A task store in this process's memory, for tests only: a production host
 * supplies a shared store (the backend's), so a task created on one replica
 * is polled on another. Two handlers given the same instance stand in for two
 * replicas.
 */
export function createMemoryTaskStore(): MockTaskStore & {
  records: Map<string, MockTaskRecord>;
} {
  const records = new Map<string, MockTaskRecord>();
  const own = (owner: string, taskId: string) => {
    const record = records.get(taskId);
    return record?.owner === owner ? record : undefined;
  };
  return {
    records,
    async create(record) {
      records.set(record.taskId, structuredClone(record));
    },
    async get(owner, taskId) {
      const record = own(owner, taskId);
      return record && structuredClone(record);
    },
    async list(owner) {
      return [...records.values()]
        .filter((record) => record.owner === owner)
        .map((record) => structuredClone(record));
    },
    async update(owner, taskId, patch: MockTaskPatch) {
      const record = own(owner, taskId);
      if (!record) return undefined;
      if (!TERMINAL.includes(record.status)) {
        const { addInputResponses, statusMessage, inputRequests, ...rest } =
          structuredClone(patch);
        Object.assign(record, rest);
        if (statusMessage === null) delete record.statusMessage;
        else if (statusMessage !== undefined) {
          record.statusMessage = statusMessage;
        }
        if (inputRequests === null) delete record.inputRequests;
        else if (inputRequests !== undefined) {
          record.inputRequests = inputRequests;
        }
        if (addInputResponses) {
          record.inputResponses = {
            ...record.inputResponses,
            ...addInputResponses,
          };
        }
      }
      return structuredClone(record);
    },
  };
}
