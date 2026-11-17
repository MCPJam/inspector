/**
 * Rates a person enters for the models they run on their own keys, kept on
 * this machine only, beside the Inspector's other device settings under
 * `~/.mcpjam/inspector/`. Nothing here is uploaded. Each save is a new
 * revision of its provider + model series with an effective date, so a priced
 * call names the revision it used and a later edit never changes it.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { RateEvidence } from "@mcpjam/sdk";
import {
  normalizeModelRateInput,
  type ModelRateInput,
} from "@/shared/model-rate-input";
import {
  modelRateRevisionZ,
  parseModelRateRevision,
  revisionInForce,
  type ParsedModelRateRevision,
} from "@/shared/model-rate-revision";
import {
  createCapabilityMutationLock,
  persistCapabilityState,
} from "../local-capability.js";

const storedRevisionZ = modelRateRevisionZ.extend({
  providerKey: z.string().min(1),
  createdAt: z.number(),
});

export type LocalRateRevision = ParsedModelRateRevision<typeof storedRevisionZ>;

export class LocalRateOverrideError extends Error {
  constructor(
    readonly code: "invalid_rate" | "not_found" | "changed",
    message: string,
  ) {
    super(message);
  }
}

/** `MCPJAM_MODEL_RATE_OVERRIDES_FILE` relocates the file, for tests. */
export function localRateOverridesFilePath(): string {
  return (
    process.env.MCPJAM_MODEL_RATE_OVERRIDES_FILE ||
    join(homedir(), ".mcpjam", "inspector", "model-rate-overrides.json")
  );
}

/** One provider + model series, newest revision first. */
function seriesOf(
  revisions: LocalRateRevision[],
  providerKey: string,
  modelId: string,
): LocalRateRevision[] {
  return revisions
    .filter((row) => row.providerKey === providerKey && row.modelId === modelId)
    .sort((a, b) => b.revision - a.revision);
}

export function createLocalRateOverrideStore(filePath: () => string) {
  const serialize = createCapabilityMutationLock();

  /**
   * `strict` is for writes, which rewrite the file from what this returns: a
   * failed read other than a missing file must not drop every saved rate, and
   * an unreadable file is moved aside rather than overwritten.
   */
  async function readRevisions(strict = false): Promise<LocalRateRevision[]> {
    let text: string;
    try {
      text = await readFile(filePath(), "utf8");
    } catch (error) {
      if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
      return [];
    }
    let revisions: unknown;
    try {
      revisions = (JSON.parse(text) as { revisions?: unknown } | null)
        ?.revisions;
    } catch {
      revisions = undefined;
    }
    if (!Array.isArray(revisions)) {
      if (strict) await rename(filePath(), `${filePath()}.unreadable`);
      return [];
    }
    return revisions.flatMap(
      (row) => parseModelRateRevision(storedRevisionZ, row) ?? [],
    );
  }

  function mutate<T>(
    change: (revisions: LocalRateRevision[]) => T,
  ): Promise<T> {
    return serialize(async () => {
      const revisions = await readRevisions(true);
      const result = change(revisions);
      await persistCapabilityState(filePath(), { version: 1, revisions });
      return result;
    });
  }

  return {
    /** The newest revision of each series in use, future ones included. */
    async list(): Promise<LocalRateRevision[]> {
      const revisions = await readRevisions();
      return revisions
        .filter(
          (row) =>
            row.retiredAt === undefined &&
            seriesOf(revisions, row.providerKey, row.modelId)[0] === row,
        )
        .sort(
          (a, b) =>
            a.modelId.localeCompare(b.modelId) ||
            a.providerKey.localeCompare(b.providerKey),
        );
    },

    async history(providerKey: string, modelId: string) {
      return seriesOf(await readRevisions(), providerKey, modelId);
    },

    /** Save the next revision; the previous one applies until its effective date. */
    async set(input: ModelRateInput, now = Date.now()) {
      const normalized = normalizeModelRateInput(input, {
        now,
        requireProvider: true,
      });
      if (!normalized.ok) {
        throw new LocalRateOverrideError("invalid_rate", normalized.message);
      }
      const {
        providerKey = "",
        modelId,
        rates,
        effectiveAt,
        note,
      } = normalized.value;
      return mutate((revisions) => {
        const newest = seriesOf(revisions, providerKey, modelId)[0];
        const saved: LocalRateRevision = {
          rateId: randomUUID(),
          providerKey,
          modelId,
          rates,
          effectiveAt,
          revision: (newest?.revision ?? 0) + 1,
          createdAt: now,
          ...(note ? { note } : {}),
        };
        revisions.push(saved);
        return saved;
      });
    },

    /** Stop using a series from now on; only its newest revision can be retired. */
    retire(rateId: string, now = Date.now()): Promise<LocalRateRevision> {
      return mutate((revisions) => {
        const row = revisions.find((candidate) => candidate.rateId === rateId);
        if (!row) {
          throw new LocalRateOverrideError(
            "not_found",
            "This rate no longer exists. Reload the rates and try again.",
          );
        }
        if (seriesOf(revisions, row.providerKey, row.modelId)[0] !== row) {
          throw new LocalRateOverrideError(
            "changed",
            "This rate changed after you opened it. Reload the rates and try again.",
          );
        }
        row.retiredAt ??= now;
        return row;
      });
    },

    /**
     * The rate in force for a call at `at`. A call matches a rate saved under
     * any of `modelIds`, so a rate entered with the canonical id also prices
     * the native id the provider was sent.
     */
    async rateFor(args: {
      providerKey: string;
      modelIds: readonly string[];
      at: number;
    }): Promise<RateEvidence | undefined> {
      const revisions = await readRevisions();
      for (const modelId of args.modelIds) {
        const row = revisionInForce(
          seriesOf(revisions, args.providerKey, modelId),
          args.at,
        );
        if (!row) continue;
        return {
          source: "customer_rate",
          rates: row.rates,
          modelId: row.modelId,
          provider: row.providerKey,
          versionId: row.rateId,
          effectiveAt: row.effectiveAt,
        };
      }
      return undefined;
    },
  };
}

export const localRateOverrides = createLocalRateOverrideStore(
  localRateOverridesFilePath,
);
