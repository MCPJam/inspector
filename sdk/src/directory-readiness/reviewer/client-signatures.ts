/**
 * Discovery requested again under other client signatures (E26).
 *
 * A server's edge can refuse a client by its user agent before any MCP code
 * runs: both discovery documents of one server answered 403 to a common HTTP
 * library and 200 to the others. A directory's own client may be refused the
 * same way, and no directory says what its client sends.
 *
 * Requests leave from MCPJam's shared addresses, and a blocked user agent
 * puts their reputation at risk (R8). So the probe sends discovery GETs only,
 * to the documents the run's own discovery found, once per signature for
 * each document, one at a time, with no retry, on the run's transport and
 * cancellation.
 *
 * Root entry only: it makes requests.
 */

import { readBoundedText } from "../discovery.js";
import {
  DIRECTORY_CLIENT_SIGNATURES,
  type DirectoryClientSignatureEvidence,
  type DirectoryClientSignatureProbe,
} from "./evidence.js";

const BODY_EXCERPT_CHARS = 2000;
const PROBE_TIMEOUT_MS = 10_000;
const DOCUMENTS = ["protected-resource", "authorization-server"] as const;

export async function probeDirectoryClientSignatures(options: {
  /** The documents the run's discovery found, by kind. */
  documents: Partial<Record<DirectoryClientSignatureProbe["document"], string>>;
  /** In a hosted run, the DNS-pinned transport. */
  fetchFn: typeof fetch;
  signal?: AbortSignal;
}): Promise<DirectoryClientSignatureEvidence> {
  const probes: DirectoryClientSignatureProbe[] = [];
  for (const document of DOCUMENTS) {
    const url = options.documents[document];
    if (!url) continue;
    for (const signature of DIRECTORY_CLIENT_SIGNATURES) {
      options.signal?.throwIfAborted();
      probes.push({
        signature: signature.id,
        document,
        url,
        ...(await probeOnce(url, signature.userAgent, options)),
      });
    }
  }
  return { probes };
}

async function probeOnce(
  url: string,
  userAgent: string | undefined,
  { fetchFn, signal }: { fetchFn: typeof fetch; signal?: AbortSignal }
): Promise<Pick<DirectoryClientSignatureProbe, "status" | "body">> {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        accept: "application/json",
        ...(userAgent ? { "user-agent": userAgent } : {}),
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: 0, body: messageOf(error) };
  }
  if (response.status < 400) {
    // An answer's body is not evidence; its connection goes back now.
    try {
      await response.body?.cancel();
    } catch {
      // Already closed: there is nothing left to release.
    }
    return { status: response.status };
  }
  const body = await readBoundedText(response).catch(
    (error: unknown) => `the body could not be read: ${messageOf(error)}`
  );
  return {
    status: response.status,
    ...(body !== undefined ? { body: body.slice(0, BODY_EXCERPT_CHARS) } : {}),
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
