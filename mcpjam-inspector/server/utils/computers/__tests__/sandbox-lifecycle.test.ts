import { describe, expect, it } from "vitest";
import {
  SANDBOX_CONNECT_MARGIN_MS,
  SandboxUnavailableError,
  isSandboxUnavailableError,
  parseSandboxVendorLifecycle,
  resolveSandboxConnectTimeoutMs,
  vendorLifecycleField,
} from "../sandbox-lifecycle.js";
import { harnessFailureEvidenceOf } from "../../harness/harness-provider-error.js";
import { classifyEvalInfraError } from "../../../services/evals/infra-error-classification.js";

const NOW = Date.parse("2026-10-05T12:00:00Z");

describe("parseSandboxVendorLifecycle", () => {
  it("keeps a well-formed policy", () => {
    expect(
      parseSandboxVendorLifecycle({
        onTimeout: "kill",
        timeoutSeconds: 1800,
        deadlineAt: NOW,
      }),
    ).toEqual({ onTimeout: "kill", timeoutSeconds: 1800, deadlineAt: NOW });
    expect(parseSandboxVendorLifecycle({ onTimeout: "pause" })).toEqual({
      onTimeout: "pause",
    });
  });

  it("reads anything malformed as absent, never as an invented window", () => {
    expect(parseSandboxVendorLifecycle(undefined)).toBeUndefined();
    expect(parseSandboxVendorLifecycle("kill")).toBeUndefined();
    expect(
      parseSandboxVendorLifecycle({ onTimeout: "explode" }),
    ).toBeUndefined();
    expect(
      parseSandboxVendorLifecycle({ onTimeout: "kill", timeoutSeconds: -1 }),
    ).toEqual({ onTimeout: "kill" });
    expect(vendorLifecycleField(null)).toEqual({});
    expect(
      vendorLifecycleField({ onTimeout: "kill", timeoutSeconds: 60 }),
    ).toEqual({ vendorLifecycle: { onTimeout: "kill", timeoutSeconds: 60 } });
  });
});

describe("resolveSandboxConnectTimeoutMs", () => {
  it("no policy ⇒ the historical connect", () => {
    expect(resolveSandboxConnectTimeoutMs(undefined, NOW)).toEqual({
      ok: true,
    });
    expect(resolveSandboxConnectTimeoutMs({ onTimeout: "pause" }, NOW)).toEqual(
      { ok: true },
    );
  });

  it("a window with no ceiling is armed as-is", () => {
    expect(
      resolveSandboxConnectTimeoutMs(
        { onTimeout: "kill", timeoutSeconds: 2700 },
        NOW,
      ),
    ).toEqual({ ok: true, timeoutMs: 2_700_000 });
  });

  it("the ceiling caps the window, and refuses inside the margin", () => {
    expect(
      resolveSandboxConnectTimeoutMs(
        { onTimeout: "kill", timeoutSeconds: 1800, deadlineAt: NOW + 600_000 },
        NOW,
      ),
    ).toEqual({ ok: true, timeoutMs: 600_000 });
    expect(
      resolveSandboxConnectTimeoutMs(
        {
          onTimeout: "kill",
          timeoutSeconds: 1800,
          deadlineAt: NOW + SANDBOX_CONNECT_MARGIN_MS - 1,
        },
        NOW,
      ),
    ).toEqual({ ok: false, reason: "expired" });
  });
});

describe("SandboxUnavailableError", () => {
  it("carries the structured evidence an infra classifier reads", () => {
    const err = new SandboxUnavailableError({
      code: "sandbox_not_found",
      phase: "broker",
      httpStatus: 404,
      sandboxId: "sbx",
    });
    expect(isSandboxUnavailableError(err)).toBe(true);
    expect(err.message).toMatch(/no longer exists/);
    expect(harnessFailureEvidenceOf(err)).toEqual({
      layer: "sandbox",
      code: "sandbox_not_found",
      httpStatus: 404,
      isRetryable: false,
    });
    expect(isSandboxUnavailableError(new Error("x"))).toBe(false);
    // …which the eval classifier records as `infraError{sandbox}`, final.
    expect(classifyEvalInfraError(harnessFailureEvidenceOf(err))).toEqual({
      class: "sandbox",
      layer: "sandbox",
      retryable: false,
      code: "sandbox_not_found",
      httpStatus: 404,
    });
  });
});
