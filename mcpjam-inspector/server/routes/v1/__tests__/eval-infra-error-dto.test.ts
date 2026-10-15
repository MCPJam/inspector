/**
 * The public projection of `testIteration.infraError` is a WHITELIST: known
 * keys only, each type-checked, and OMITTED (never nulled) on a trial without
 * one — so every existing row's DTO is byte-identical.
 */
import { describe, expect, it } from "vitest";
import { toInfraErrorProjection } from "../eval-infra-error-projection.js";

describe("iteration infraError projection", () => {
  it("projects the known keys of a stored marker", () => {
    expect(
      toInfraErrorProjection({
        class: "rate_limited",
        layer: "model",
        retryable: true,
        code: "mcpjam_rate_limit",
        httpStatus: 429,
      }),
    ).toEqual({
      infraError: {
        class: "rate_limited",
        layer: "model",
        retryable: true,
        code: "mcpjam_rate_limit",
        httpStatus: 429,
      },
    });
  });

  it("omits the field entirely for a trial without one", () => {
    expect(toInfraErrorProjection(undefined)).toEqual({});
    expect(toInfraErrorProjection(null)).toEqual({});
    expect(toInfraErrorProjection("provider_unavailable")).toEqual({});
    // A marker without its class and layer is not one.
    expect(toInfraErrorProjection({ retryable: true })).toEqual({});
  });

  it("drops anything beyond the contract and mistyped optionals", () => {
    expect(
      toInfraErrorProjection({
        class: "auth",
        layer: "model",
        retryable: false,
        code: 401,
        httpStatus: "401",
        rawProviderBody: "secret",
      }),
    ).toEqual({
      infraError: { class: "auth", layer: "model", retryable: false },
    });
  });
});
