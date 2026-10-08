/**
 * The public projection of `testIteration.infraError`: MCPJam's own
 * infrastructure (the model provider, the sandbox, the platform) failed the
 * trial, so it measured nothing about the server and every score excludes it.
 *
 * A WHITELIST like every other projection here: known keys only, each
 * type-checked, so nothing the row carries beyond the contract crosses the
 * boundary. OMITTED — never nulled — for a trial without one.
 */
export type InfraErrorDto = {
  class: string;
  layer: string;
  retryable: boolean;
  code?: string;
  httpStatus?: number;
};

export function toInfraErrorProjection(raw: unknown): {
  infraError?: InfraErrorDto;
} {
  if (!raw || typeof raw !== "object") return {};
  const row = raw as Record<string, unknown>;
  if (typeof row.class !== "string" || typeof row.layer !== "string") return {};
  return {
    infraError: {
      class: row.class,
      layer: row.layer,
      retryable: row.retryable === true,
      ...(typeof row.code === "string" ? { code: row.code } : {}),
      ...(typeof row.httpStatus === "number"
        ? { httpStatus: row.httpStatus }
        : {}),
    },
  };
}
