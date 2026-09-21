import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { ERROR_MESSAGES } from "../error-messages";
import {
  githubChecksWriteErrorMessage,
  githubFeedbackCommentsErrorMessage,
} from "../github-checks-errors";

function productionError(data: string | { message: string }) {
  const error = new ConvexError(data);
  error.message = "[Request ID: private-id] Server Error";
  return error;
}

describe("GitHub error guidance", () => {
  it.each([
    [
      "Repository is not accessible to the MCPJam GitHub App.",
      ERROR_MESSAGES.githubRepositoryAccess,
    ],
    [
      "GitHub could not be reached right now. Please try again.",
      ERROR_MESSAGES.githubUnreachable,
    ],
    [
      "GitHub Checks settings are not currently available.",
      ERROR_MESSAGES.githubUnavailable,
    ],
  ])("maps a known refusal to catalog guidance: %s", (backend, expected) => {
    expect(githubChecksWriteErrorMessage(productionError(backend))).toBe(
      expected,
    );
  });

  it("maps a known structured refusal without exposing request details", () => {
    expect(
      githubChecksWriteErrorMessage(
        productionError({ message: "You are not an admin." }),
      ),
    ).toBe(ERROR_MESSAGES.githubAdminRequired);
  });

  it.each([
    undefined,
    null,
    {},
    new Error("private details"),
    productionError("private details"),
  ])("uses operation-specific defaults for unknown failures", (error) => {
    expect(githubChecksWriteErrorMessage(error)).toBe(
      ERROR_MESSAGES.githubSaveFailed,
    );
    expect(githubFeedbackCommentsErrorMessage(error)).toBe(
      ERROR_MESSAGES.githubCommentsFailed,
    );
  });

  it("preserves known recovery advice for comment settings", () => {
    expect(
      githubFeedbackCommentsErrorMessage(
        productionError("GitHub Checks settings are not currently available."),
      ),
    ).toBe(ERROR_MESSAGES.githubUnavailable);
  });

  it("lets the installation flow choose a relevant catalog fallback", () => {
    expect(
      githubChecksWriteErrorMessage(
        new Error("secret"),
        ERROR_MESSAGES.weCouldNotFinishConnectingThatGithubAccountThisIs,
      ),
    ).toBe(ERROR_MESSAGES.weCouldNotFinishConnectingThatGithubAccountThisIs);
  });
});
