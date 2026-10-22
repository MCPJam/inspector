import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HARNESS_PROXY_REFUSAL_REASONS,
  HARNESS_PROXY_REFUSAL_STATUS,
  isHarnessProxyRefusalReason,
  type HarnessOrgKeyRefusalReason,
} from "../harness-proxy-refusal-reasons";

describe("harness proxy refusal vocabulary", () => {
  it("answers its own refusals with 409", () => {
    expect(HARNESS_PROXY_REFUSAL_STATUS).toBe(409);
  });

  it("every reason says whether it invites a retry", () => {
    for (const row of Object.values(HARNESS_PROXY_REFUSAL_REASONS)) {
      expect(typeof row.retry).toBe("boolean");
    }
  });

  it("never invites a re-send of an org-key refusal the model contract names", () => {
    // `ModelRefusalCode` takes these from the vocabulary, so a reason renamed
    // here no longer type-checks there. A failure the proxy itself answered
    // must not invite the runtime to re-send: the proxy never retries, and
    // neither may its caller.
    const orgCodes: HarnessOrgKeyRefusalReason[] = [
      "org_keys_required",
      "byok_credential_rejected",
      "byok_credential_unavailable",
      "byok_connection_changed",
      "transport_request_too_large",
      "transport_response_too_large",
    ];
    for (const code of orgCodes) {
      expect(HARNESS_PROXY_REFUSAL_REASONS[code].retry).toBe(false);
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
      "117ad281f2c3e22b082f605e2981f4542589a7541f8997ea51fb65009b439406",
    );
  });
});
