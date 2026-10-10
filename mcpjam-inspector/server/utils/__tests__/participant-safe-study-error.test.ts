import { describe, expect, it } from "vitest";
import {
  PARTICIPANT_STUDY_AT_LIMIT,
  PARTICIPANT_STUDY_MISCONFIGURED,
  participantSafeStudyError,
} from "../scenario-runtime-config.js";

/**
 * A study tester never sees the organization's AI configuration: a refusal by
 * the org-key policy ("Use your keys for all AI features") is something only
 * the study's owner can fix, and the backend's copy for it names admin
 * settings the tester cannot see.
 */
describe("participantSafeStudyError — the organization AI-key policy", () => {
  it.each([
    ["org_keys_required", 403],
    ["org_model_unconfigured", 422],
    ["org_runtime_unsupported", 422],
    ["ai_scope_unresolved", 403],
    ["provider_auth_failed", 422],
    ["credential_missing", 422],
  ])("tells the tester the study is misconfigured on %s", (code, status) => {
    expect(
      participantSafeStudyError({
        status,
        code,
        error:
          "This organization requires its own provider keys for AI features. Choose a model from an organization provider.",
      }),
    ).toBe(PARTICIPANT_STUDY_MISCONFIGURED);
  });

  it("reads the policy's transient refusals as a wait", () => {
    expect(
      participantSafeStudyError({
        status: 503,
        code: "provider_unavailable",
        error: "The organization's provider is temporarily unavailable.",
      }),
    ).toBe(PARTICIPANT_STUDY_AT_LIMIT);
  });
});
