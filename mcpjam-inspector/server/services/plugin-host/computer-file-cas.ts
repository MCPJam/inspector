import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { z } from "zod";
import { logger } from "../../utils/logger.js";
import { HOME_ROOT } from "../../utils/computers/path-confine.js";
import { COMPUTER_FILE_CAS_COMMAND } from "./computer-file-cas-helper.js";
import { ResourceGrantError, type ResourceWriteOutcome } from "./resource-grants.js";

export interface ComputerCompareAndReplaceInput {
  root: string;
  path: string;
  bytes: Uint8Array;
  expectedEtag: string;
  maxBytes: number;
}
/** Atomic among MCPJam writers sharing this VM and target lock. Arbitrary shell
 * writes do not participate; the admitted target requires exclusiveWrites. */
export type ComputerCompareAndReplace = (
  input: ComputerCompareAndReplaceInput,
  options?: { signal?: AbortSignal },
) => Promise<Exclude<ResourceWriteOutcome, { outcome: "too-large" }>>;

export interface ComputerCasTransport {
  write(path: string, bytes: ArrayBuffer, options?: { signal?: AbortSignal; requestTimeoutMs?: number }): Promise<unknown>;
  run(command: string, options: { envs: Record<string, string>; timeoutMs: number; signal?: AbortSignal }): Promise<{ stdout: string }>;
}

const fileId = z.string().regex(/^[0-9]{1,24}$/);
const pair = z.tuple([fileId, fileId]);
const stageSchema = z.object({ outcome: z.literal("staged"), directoryIdentity: pair, fileIdentity: pair });
const resultSchema = z.object({ outcome: z.enum(["saved", "conflict"]), etag: z.string().regex(/^[a-f0-9]{64}$/) });
const outcomeSchema = z.object({ outcome: z.string() });
type Stage = z.infer<typeof stageSchema> & { root: string; path: string; stageId: string };
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Owns one fixed helper protocol; no caller can provide a command or script. */
export function createComputerFileCas(transport: ComputerCasTransport) {
  const call = async (request: Record<string, unknown>, signal?: AbortSignal) => {
    const result = await transport.run(COMPUTER_FILE_CAS_COMMAND, {
      envs: { MCPJAM_FILE_CAS: Buffer.from(JSON.stringify(request)).toString("base64url") },
      timeoutMs: 15_000,
      ...(signal ? { signal } : {}),
    });
    if (result.stdout.length > 4096) throw new Error("Invalid Computer save response");
    return JSON.parse(result.stdout) as unknown;
  };
  const stage = async (root: string, path: string, signal?: AbortSignal): Promise<Stage> => {
    signal?.throwIfAborted();
    const request = { root, path, stageId: randomUUID().replaceAll("-", "") };
    // Retain the cleanup identity even if the caller cancels during allocation.
    return { ...request, ...stageSchema.parse(await call({ ...request, op: "stage" })) };
  };
  const cleanup = async (staged: Stage) => {
    try {
      const response = outcomeSchema.parse(await call({ ...staged, op: "cleanup" }));
      if (response.outcome !== "cleaned") throw new Error("Cleanup refused");
    } catch {
      // A failed cleanup cannot undo a known replacement or justify replaying it.
      logger.warn("Computer save staging cleanup unavailable");
    }
  };
  const upload = async (staged: Stage, bytes: Uint8Array, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const data = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(data).set(bytes);
    // Complete the bounded staging upload before cleanup; cancellation cannot
    // race removal against an upload still writing on the VM.
    await transport.write(posix.join(posix.dirname(staged.path), `.mcpjam-cas-${staged.stageId}`, "payload"), data, { requestTimeoutMs: 15_000 });
    signal?.throwIfAborted();
  };
  let qualification: Promise<boolean> | undefined;
  const supports = async (signal?: AbortSignal): Promise<boolean> => {
    signal?.throwIfAborted();
    qualification ??= (async () => {
      let staged: Stage | undefined;
      try {
        if (outcomeSchema.parse(await call({ op: "probe" }, signal)).outcome !== "ready") return false;
        staged = await stage(HOME_ROOT, `${HOME_ROOT}/.mcpjam-cas-probe`, signal);
        const bytes = new Uint8Array([0]);
        await upload(staged, bytes, signal);
        const response = outcomeSchema.parse(await call({ ...staged, op: "verify", maxBytes: 1, size: 1, sha256: digest(bytes) }, signal));
        return response.outcome === "ready";
      } catch {
        return false;
      } finally {
        if (staged) await cleanup(staged);
      }
    })();
    const supported = await qualification;
    signal?.throwIfAborted();
    return supported;
  };
  const compareAndReplace: ComputerCompareAndReplace = async (input, options) => {
    const signal = options?.signal;
    signal?.throwIfAborted();
    if (!(await supports(signal))) throw new ResourceGrantError("RESOURCE_WRITE_UNAVAILABLE");
    if (input.bytes.byteLength > input.maxBytes) throw new ResourceGrantError("RESOURCE_TOO_LARGE");
    let staged: Stage | undefined;
    let dispatched = false;
    try {
      staged = await stage(input.root, input.path, signal);
      await upload(staged, input.bytes, signal);
      signal?.throwIfAborted();
      dispatched = true;
      // Once dispatched, wait for the bounded atomic operation; cancelling the
      // RPC cannot establish whether replacement happened and must not replay it.
      const response = await call({ ...staged, op: "commit", maxBytes: input.maxBytes, size: input.bytes.byteLength, sha256: digest(input.bytes), expectedEtag: input.expectedEtag });
      if (signal?.aborted) throw new ResourceGrantError("RESOURCE_OUTCOME_UNKNOWN");
      const result = resultSchema.safeParse(response);
      if (result.success) return result.data;
      const outcome = outcomeSchema.parse(response).outcome;
      if (outcome === "too-large") throw new ResourceGrantError("RESOURCE_TOO_LARGE");
      if (outcome === "denied") throw new ResourceGrantError("RESOURCE_DENIED");
      throw new ResourceGrantError("RESOURCE_OUTCOME_UNKNOWN");
    } catch (error) {
      if (!signal?.aborted && !(error instanceof ResourceGrantError &&
          ["RESOURCE_DENIED", "RESOURCE_TOO_LARGE"].includes(error.code))) {
        qualification = Promise.resolve(false);
      }
      if (error instanceof ResourceGrantError) throw error;
      if (dispatched) throw new ResourceGrantError("RESOURCE_OUTCOME_UNKNOWN");
      signal?.throwIfAborted();
      throw new ResourceGrantError("RESOURCE_WRITE_UNAVAILABLE");
    } finally {
      if (staged) await cleanup(staged);
    }
  };
  return { supports, compareAndReplace };
}
