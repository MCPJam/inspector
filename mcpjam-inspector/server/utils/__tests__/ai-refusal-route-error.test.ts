import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import { originOf } from "@mcpjam/sdk";
import {
  aiRefusalRouteError,
  asAiRefusalRouteError,
} from "../ai-refusal-route-error.js";
import { ModelResolutionRefusalError } from "../model-resolution-local.js";
import { WebRouteError } from "../../routes/web/errors.js";

describe("asAiRefusalRouteError", () => {
  it("answers an eval launch refusal with its code, remediation and problems", () => {
    const launch = new ConvexError({
      code: "org_keys_required",
      message:
        "This organization requires its own provider keys for AI features.",
      problems: [
        {
          dependency: "target",
          label: "anthropic/claude-haiku-4.5",
          code: "org_keys_required",
          reason: "MCPJam-provided model",
        },
      ],
    });
    const error = asAiRefusalRouteError(launch);
    expect(error).toBeInstanceOf(WebRouteError);
    expect(error?.status).toBe(403);
    expect(error?.code).toBe("FORBIDDEN");
    expect(error?.details).toMatchObject({
      code: "org_keys_required",
      remediation: "choose_org_model",
      problems: [expect.objectContaining({ dependency: "target" })],
    });
    expect(error?.normalized?.slug).toBe("org/keys_required");
    // The organization's own configuration: never paged.
    expect(originOf(error?.normalized)).toBe("user_config");
  });

  it.each([
    ["org_model_unconfigured", "org/model_unconfigured"],
    ["org_runtime_unsupported", "org/runtime_unsupported"],
    ["credential_missing", "org/credential_missing"],
  ])("answers %s with 422 and its slug", (code, slug) => {
    const error = asAiRefusalRouteError(
      new ConvexError({ code, message: "Refused." }),
    );
    expect(error?.status).toBe(422);
    expect(error?.code).toBe("FEATURE_NOT_SUPPORTED");
    expect(error?.details?.code).toBe(code);
    expect(error?.normalized?.slug).toBe(slug);
  });

  it("answers a launch refusal led by invalid_model with 422, keeping every problem", () => {
    // `assertLaunchPreflight`: the primary code is the first problem's when
    // none of the policy codes is present.
    const launch = new ConvexError({
      code: "invalid_model",
      message:
        "This organization requires its own provider keys for AI features, and this launch has 2 dependencies that can't run on them: …",
      problems: [
        {
          dependency: "target",
          label: "gpt-5-mini",
          code: "invalid_model",
          reason: "gpt-5-mini: not served by its connection.",
        },
        {
          dependency: "judge",
          label: "The judge",
          code: "capability_unknown",
          reason: "The judge: support unknown.",
        },
      ],
    });
    const error = asAiRefusalRouteError(launch);
    expect(error?.status).toBe(422);
    expect(error?.code).toBe("FEATURE_NOT_SUPPORTED");
    expect(error?.details).toMatchObject({
      code: "invalid_model",
      remediation: "configure_org_model_role",
      problems: [
        expect.objectContaining({ code: "invalid_model" }),
        expect.objectContaining({ code: "capability_unknown" }),
      ],
    });
    expect(error?.normalized?.slug).toBe("org/model_unconfigured");
    expect(originOf(error?.normalized)).toBe("user_config");
  });

  it.each(["capability_missing", "capability_unknown", "invalid_model"])(
    "answers a bare %s launch refusal with 422",
    (code) => {
      const error = asAiRefusalRouteError(
        new ConvexError({ code, message: "Refused." }),
      );
      expect(error?.status).toBe(422);
      expect(error?.details?.code).toBe(code);
    },
  );

  it("answers a launch refusal with an unfamiliar code when it lists problems", () => {
    const error = asAiRefusalRouteError(
      new ConvexError({
        code: "some_future_code",
        message: "Refused.",
        problems: [
          { dependency: "persona", label: "x", code: "x", reason: "x" },
        ],
      }),
    );
    expect(error?.status).toBe(422);
    expect(error?.details).toMatchObject({
      code: "some_future_code",
      remediation: "contact_support",
      problems: [expect.objectContaining({ dependency: "persona" })],
    });
    expect(error?.normalized?.slug).toBe("org/keys_required");
  });

  it("answers a typed resolver refusal", () => {
    const error = asAiRefusalRouteError(
      new ModelResolutionRefusalError([
        { code: "org_keys_required", reason: "local runtime" },
      ]),
    );
    expect(error?.status).toBe(403);
    expect(error?.details).toMatchObject({
      code: "org_keys_required",
      refusals: [{ code: "org_keys_required", reason: "local runtime" }],
    });
  });

  it("leaves transient, unrelated and already-routed errors alone", () => {
    expect(
      asAiRefusalRouteError(
        new ConvexError({ code: "ai_policy_unavailable", message: "x" }),
      ),
    ).toBeNull();
    expect(
      asAiRefusalRouteError(
        new ConvexError({
          code: "provider_unavailable",
          message: "x",
          problems: [],
        }),
      ),
    ).toBeNull();
    expect(
      asAiRefusalRouteError(
        new ConvexError({ code: "billing_limit_reached", message: "x" }),
      ),
    ).toBeNull();
    expect(
      asAiRefusalRouteError(
        new ModelResolutionRefusalError([
          { code: "invalid_model", reason: "x" },
        ]),
      ),
    ).toBeNull();
    expect(asAiRefusalRouteError(new Error("boom"))).toBeNull();
    expect(
      asAiRefusalRouteError(aiRefusalRouteError("org_keys_required", "x")),
    ).toBeNull();
  });
});
