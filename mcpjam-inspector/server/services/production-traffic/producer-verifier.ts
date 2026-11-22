/**
 * Checks a producer credential (`mjotlp_…`) against the install's own Convex,
 * once per OTLP batch.
 *
 * Only the digest leaves this process: `productionIngestService:verify`
 * receives `base64url(sha256("production-ingest:" + token))`, the contract in
 * the backend's `lib/productionIngestToken.ts`. Nothing is cached, so a
 * revocation refuses the next batch after it commits. When Convex cannot
 * answer, the batch is refused as retryable; it is never admitted unchecked.
 */
import { createHash, randomUUID } from "node:crypto";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { getServiceCredential } from "../service-credential.js";

export const PRODUCER_TOKEN_PATTERN = /^mjotlp_[A-Za-z0-9_-]{43}$/;

const VERIFY_TIMEOUT_MS = 5_000;
const VERIFY = makeFunctionReference<"query">("productionIngestService:verify");

export type ProducerRefusal =
  | "unknown_credential"
  | "revoked"
  | "expired"
  | "project_mismatch"
  | "project_unavailable"
  | "ingest_disabled";

export type ProducerVerdict =
  | {
      ok: true;
      projectId: string;
      organizationId: string;
      credentialId: string;
    }
  | { ok: false; reason: ProducerRefusal };

export interface ProducerVerifier {
  verify(projectId: string, token: string): Promise<ProducerVerdict>;
}

/** Convex could not answer: refuse the batch as retryable. */
export class ProducerVerificationUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProducerVerificationUnavailableError";
  }
}

const REFUSALS = new Set<string>([
  "unknown_credential",
  "revoked",
  "expired",
  "project_mismatch",
  "project_unavailable",
  "ingest_disabled",
]);

export function hashProducerToken(token: string): string {
  return createHash("sha256")
    .update(`production-ingest:${token}`)
    .digest("base64url");
}

function parseVerdict(value: unknown): ProducerVerdict {
  if (typeof value === "object" && value !== null) {
    const verdict = value as Record<string, unknown>;
    if (
      verdict.ok === true &&
      typeof verdict.projectId === "string" &&
      typeof verdict.organizationId === "string" &&
      typeof verdict.credentialId === "string"
    ) {
      return {
        ok: true,
        projectId: verdict.projectId,
        organizationId: verdict.organizationId,
        credentialId: verdict.credentialId,
      };
    }
    if (
      verdict.ok === false &&
      typeof verdict.reason === "string" &&
      REFUSALS.has(verdict.reason)
    ) {
      return { ok: false, reason: verdict.reason as ProducerRefusal };
    }
  }
  throw new ProducerVerificationUnavailableError(
    "The credential check returned an unrecognized answer",
  );
}

export function createConvexProducerVerifier(
  env: Record<string, string | undefined> = process.env,
): ProducerVerifier | null {
  const convexUrl = env.CONVEX_URL?.trim();
  const serviceToken = getServiceCredential(env);
  if (!convexUrl || !serviceToken) return null;
  const client = new ConvexHttpClient(convexUrl, {
    logger: false,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
      }),
  });
  return {
    async verify(projectId, token) {
      let answer: unknown;
      try {
        answer = await client.query(VERIFY, {
          serviceToken,
          requestId: randomUUID(),
          command: { projectId, tokenHash: hashProducerToken(token) },
        });
      } catch (error) {
        throw new ProducerVerificationUnavailableError(
          "The credential check did not answer",
          { cause: error },
        );
      }
      return parseVerdict(answer);
    },
  };
}

let shared: ProducerVerifier | null | undefined;

/** This process's verifier, or null without CONVEX_URL and the service token. */
export function getProducerVerifier(): ProducerVerifier | null {
  if (shared === undefined) shared = createConvexProducerVerifier();
  return shared;
}
