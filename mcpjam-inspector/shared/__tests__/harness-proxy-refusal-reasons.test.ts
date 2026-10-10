import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVAL_INFRA_ERROR_CLASSES } from "../eval-infra-error";
import {
  HARNESS_PROXY_REFUSAL_REASONS,
  HARNESS_PROXY_REFUSAL_STATUS,
  isHarnessProxyRefusalReason,
} from "../harness-proxy-refusal-reasons";
import type { ModelRefusalCode } from "../../server/utils/model-resolution-local";

describe("harness proxy refusal vocabulary", () => {
  it("answers its own refusals with 409", () => {
    expect(HARNESS_PROXY_REFUSAL_STATUS).toBe(409);
  });

  it("every class is an eval infra class or null", () => {
    for (const row of Object.values(HARNESS_PROXY_REFUSAL_REASONS)) {
      expect(
        row.class === null ||
          (EVAL_INFRA_ERROR_CLASSES as readonly string[]).includes(row.class),
      ).toBe(true);
      expect(typeof row.retry).toBe("boolean");
    }
  });

  it("carries every org-key refusal the model contract names", () => {
    const orgCodes: ModelRefusalCode[] = [
      "org_keys_required",
      "byok_credential_rejected",
      "byok_credential_unavailable",
      "byok_connection_changed",
      "transport_request_too_large",
      "transport_response_too_large",
    ];
    for (const code of orgCodes) {
      expect(isHarnessProxyRefusalReason(code)).toBe(true);
    }
    // A failure the proxy itself answered must not invite the runtime to
    // re-send: the proxy never retries, and neither may its caller.
    for (const code of orgCodes) {
      if (isHarnessProxyRefusalReason(code)) {
        expect(HARNESS_PROXY_REFUSAL_REASONS[code].retry).toBe(false);
      }
    }
  });

  it("is not fooled by inherited keys", () => {
    expect(isHarnessProxyRefusalReason("toString")).toBe(false);
    expect(isHarnessProxyRefusalReason(undefined)).toBe(false);
  });

  it("pins the JSON bytes the backend mirrors", () => {
    // The backend keeps a byte-for-byte copy and pins it in its
    // `convex/lib/mirrors.json`; a change here is a change there.
    const here = dirname(fileURLToPath(import.meta.url));
    const bytes = readFileSync(
      join(here, "..", "harness-proxy-refusal-reasons.json"),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "a72423ceb07461936298c9b2be4bcc3f68224185263d5f18112f029763ee569b",
    );
  });
});
