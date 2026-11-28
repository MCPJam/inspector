/**
 * A mock's records, over the backend (`mockRecords:execute`, B5): the one
 * place the Inspector names that function. Each call is one atomic backend
 * mutation, so two replicas never see different copies.
 *
 * Which copy a call works on is the state context the route passes: the saved
 * version's shared records for an ordinary connection, or a run's own copy at
 * its epoch (the run's door sets it). Record bodies cross as JSON text because
 * Convex rejects some keys a record may hold.
 *
 * The backend throws, rather than answers, when the run itself cannot be used
 * (closed, expired, gone, someone else's). Those become a refusal the SDK
 * answers as a tool error, worded for the caller. Any other failure is an
 * infrastructure failure and passes through.
 */
import { makeFunctionReference } from "convex/server";
import {
  MockRecordRefusedError,
  type MockRecordOp,
  type MockRecordOutcome,
  type MockRecordStore,
  type MockRecordWrite,
  type MockStateContext,
} from "@mcpjam/sdk/mocks";
import { createConvexClient } from "../../routes/v1/convex-client.js";
import { convexErrorData } from "../../routes/v1/convex-errors.js";

const execute = makeFunctionReference<"mutation">("mockRecords:execute");

/** What a caller reads when the backend refuses the run or the record, by the backend's code. */
const REFUSAL_MESSAGES: Record<string, string> = {
  MOCK_RUN_CLOSED:
    "This test run was closed, so its records can no longer be read or changed. Open a new run and connect to its URL.",
  MOCK_RUN_EXPIRED:
    "This test run expired (a run lasts 24 hours). Open a new run and connect to its URL.",
  MOCK_RUN_NOT_FOUND:
    "This test run no longer exists, because closed and expired runs are removed. Open a new run and connect to its URL.",
  MOCK_RUN_FORBIDDEN:
    "This test run was opened by someone else, and only the person who opened it can use it. Open your own run, or ask its owner to share the results.",
  MOCK_RECORD_TOO_LARGE:
    "The record is larger than a mock can store (131,072 characters). Store less in it, or split it across records.",
  MOCK_RECORD_INVALID:
    "The record operation was refused because its collection or key is not valid (a collection is at most 128 characters and a key at most 256). Use shorter names.",
};

type WireOutcome =
  | { ok: true; kind: "record"; key: string; recordJson: string }
  | { ok: true; kind: "deleted"; key: string }
  | { ok: true; kind: "page"; recordsJson: string; nextCursor?: string }
  | { ok: false; code: Extract<MockRecordOutcome, { ok: false }>["code"] };

/** A scope holds at most 10,000 records; the way out differs for shared records and a run's copy. */
function recordsFullMessage(context: MockStateContext): string {
  return context.scope === "run"
    ? "This test run already holds 10,000 records, the most it can. Delete some records, or reset the run to start from the saved seed."
    : "This mock's shared records already hold 10,000 records, the most they can. Delete some records, then call again.";
}

function fromWire(outcome: WireOutcome): MockRecordOutcome {
  if (!outcome.ok || outcome.kind === "deleted") return outcome;
  if (outcome.kind === "record") {
    return { ok: true, kind: "record", key: outcome.key, record: JSON.parse(outcome.recordJson) };
  }
  return {
    ok: true,
    kind: "page",
    records: JSON.parse(outcome.recordsJson),
    ...(outcome.nextCursor !== undefined && { nextCursor: outcome.nextCursor }),
  };
}

/** `token` is a Convex bearer for the caller, read for each call. */
export function backendRecordStore(token: () => Promise<string>, mockId: string, version: number): MockRecordStore {
  return {
    execute: async (context: MockStateContext, op: MockRecordOp, write?: MockRecordWrite) => {
      try {
        const client = createConvexClient(await token());
        const outcome = (await client.mutation(execute, {
          mockId,
          version,
          context,
          opJson: JSON.stringify(op),
          ...(write && { write }),
        })) as WireOutcome;
        // Worded here because only the host knows whether this is a run or the shared records.
        if (!outcome.ok && outcome.code === "records_full") {
          throw new MockRecordRefusedError(recordsFullMessage(context));
        }
        return fromWire(outcome);
      } catch (error) {
        const code = convexErrorData(error)?.code;
        const message = typeof code === "string" ? REFUSAL_MESSAGES[code] : undefined;
        if (message) throw new MockRecordRefusedError(message);
        throw error;
      }
    },
  };
}
