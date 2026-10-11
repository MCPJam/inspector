/**
 * The Muse gather half: the only Muse-readiness code that dials anything.
 *
 * Symmetrical with `gatherClaudeReadinessEvidence` and reusing the same
 * publisher-neutral transport pieces — the hop-by-hop redirect trace and the
 * MCP dial — so the bounded reads, SSE handling and session plumbing those
 * learned the hard way apply here unchanged. Muse needs less than either
 * other publisher: no auth discovery (its public guidelines set no OAuth
 * discovery requirement; credentials are handed over in the form, §5.4) and no
 * app resources (Muse has no UI surface).
 *
 * The result is a plain object that survives `JSON.stringify`, so a hosted
 * node can gather on one machine and grade on another.
 *
 * `fetchFn` IS REQUIRED to gather any wire evidence, with no default: in a
 * hosted run it must be the DNS-pinned transport.
 *
 * Node entry only — exported from `sdk/src/index.ts`, never from `browser.ts`.
 */

import { traceRedirects } from "../directory-readiness/discovery.js";
import {
  dialMcpServer,
  type DirectoryDialOptions,
  type DirectoryToolEvidence,
} from "../directory-readiness/mcp-dial.js";
import type { MuseEndpointEvidence } from "./checks/endpoint.js";
import type { MuseReadinessInput } from "./runner.js";
import type { MuseRunnerCapability } from "./types.js";

export interface GatherMuseReadinessEvidenceOptions extends Omit<
  DirectoryDialOptions,
  "enteredUrl" | "fetchFn"
> {
  /** The connector URL exactly as the user entered it. Never canonicalized. */
  enteredUrl: string;
  /**
   * The transport. Without it the gatherer dials nothing and every wire lane
   * reports its gap — the honest outcome for a run assembled from supplied
   * evidence alone.
   */
  fetchFn?: typeof fetch;
  /** Composed into every request, so a cancelled run stops the one in flight. */
  signal?: AbortSignal;
  capabilities?: MuseRunnerCapability[];
  /**
   * A tool listing the caller already holds — typically one read with the
   * submitter's credentials, since an OAuth connector refuses an anonymous
   * `tools/list`. Supplying it skips the dial.
   */
  tools?: DirectoryToolEvidence[];
  submissionProfile?: unknown;
  evidenceSources?: string[];
  /** Injected so two gathers over the same inputs produce the same object. */
  now?: () => Date;
}

/** Gather everything a Muse readiness grade needs. */
export async function gatherMuseReadinessEvidence(
  options: GatherMuseReadinessEvidenceOptions
): Promise<MuseReadinessInput> {
  const now = options.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const discovery = options.fetchFn
    ? {
        enteredUrl: options.enteredUrl,
        fetchFn: options.fetchFn,
        timeoutMs: options.timeoutMs,
        maxRedirects: options.maxRedirects,
        headers: options.headers,
        signal: options.signal,
      }
    : undefined;

  const endpoint: MuseEndpointEvidence = discovery
    ? await traceRedirects(discovery)
    : { enteredUrl: options.enteredUrl };

  // AN EXPLICIT EMPTY ARRAY IS A SUPPLIED LISTING: the caller has established
  // that this server advertises no tools, and dialling over the top of that
  // would replace their answer with ours.
  const hasSuppliedTools = options.tools !== undefined;
  const dialled =
    discovery && !hasSuppliedTools
      ? await dialMcpServer({
          ...discovery,
          maxListPages: options.maxListPages,
          maxListEntries: options.maxListEntries,
        })
      : undefined;

  const finishedAt = now();

  return {
    enteredUrl: options.enteredUrl,
    capabilities: options.capabilities ?? [],
    startedAt,
    evaluatedAt: finishedAt.toISOString(),
    durationMs: Math.max(
      0,
      finishedAt.getTime() - new Date(startedAt).getTime()
    ),
    endpoint,
    tools: hasSuppliedTools ? options.tools : dialled?.tools?.entries,
    toolListingComplete: hasSuppliedTools
      ? undefined
      : dialled?.tools?.complete,
    toolListingError: hasSuppliedTools ? undefined : dialled?.tools?.error,
    submissionProfile: options.submissionProfile,
    evidenceSources: options.evidenceSources,
  };
}
