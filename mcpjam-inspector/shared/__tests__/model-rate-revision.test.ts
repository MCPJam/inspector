import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  modelRateRevisionZ,
  parseModelRateRevision,
  revisionInForce,
} from "../model-rate-revision";

const rates = { currency: "USD", input: 3, output: 15 };
const row = {
  rateId: "r1",
  modelId: "gpt-4.1",
  providerKey: "openai",
  rates,
  effectiveAt: 100,
  revision: 1,
};

describe("parseModelRateRevision", () => {
  it("reads a revision and checks its rates", () => {
    expect(parseModelRateRevision(modelRateRevisionZ, row)).toEqual(row);
    expect(
      parseModelRateRevision(modelRateRevisionZ, {
        ...row,
        rates: { currency: "USD", input: "3" },
      }),
    ).toBeUndefined();
    expect(
      parseModelRateRevision(modelRateRevisionZ, { ...row, rateId: "" }),
    ).toBeUndefined();
    expect(parseModelRateRevision(modelRateRevisionZ, "r1")).toBeUndefined();
  });

  it("reads with an extended shape, keeping its extra fields", () => {
    const stored = modelRateRevisionZ.extend({
      providerKey: z.string().min(1),
      createdAt: z.number(),
    });
    expect(parseModelRateRevision(stored, { ...row, createdAt: 5 })).toEqual({
      ...row,
      createdAt: 5,
    });
    expect(
      parseModelRateRevision(stored, { ...row, providerKey: undefined }),
    ).toBeUndefined();
  });
});

describe("revisionInForce", () => {
  const rev = (revision: number, effectiveAt: number, retiredAt?: number) => ({
    revision,
    effectiveAt,
    ...(retiredAt === undefined ? {} : { retiredAt }),
  });

  it("picks the newest revision already effective", () => {
    const series = [rev(3, 300), rev(2, 200), rev(1, 100)];
    expect(revisionInForce(series, 50)).toBeUndefined();
    expect(revisionInForce(series, 100)).toBe(series[2]);
    expect(revisionInForce(series, 250)).toBe(series[1]);
    expect(revisionInForce(series, 300)).toBe(series[0]);
  });

  it("applies none from a retirement on, even one on a newer revision not yet effective", () => {
    const series = [rev(2, 500, 400), rev(1, 100)];
    expect(revisionInForce(series, 399)).toBe(series[1]);
    expect(revisionInForce(series, 400)).toBeUndefined();
    expect(revisionInForce(series, 600)).toBeUndefined();
  });

  it("starts over when a series is saved again after a retirement", () => {
    const series = [rev(3, 700), rev(2, 200, 400), rev(1, 100)];
    expect(revisionInForce(series, 500)).toBeUndefined();
    expect(revisionInForce(series, 700)).toBe(series[0]);
  });
});
