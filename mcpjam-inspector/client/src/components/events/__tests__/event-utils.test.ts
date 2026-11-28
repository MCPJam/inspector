import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { errorMessage } from "../event-utils";

const REFUSAL =
  "flight.status_changed is already subscribed under MCPJam (built-in) with the same arguments. Remove that subscription in the Events tab, then subscribe again.";

describe("errorMessage", () => {
  it("shows a backend refusal's own sentence, not Convex's wrapper", () => {
    const refused = new ConvexError({ code: "CONFLICT", message: REFUSAL });
    refused.message =
      "[CONVEX M(eventSubscriptions:create)] [Request ID: abc123] Server Error";
    expect(errorMessage(refused, "Could not subscribe. Try again.")).toBe(
      REFUSAL,
    );
  });

  it("keeps other errors' messages, and falls back when there is none", () => {
    expect(
      errorMessage(
        new Error("Reconnect the server before connecting an event."),
        "x",
      ),
    ).toBe("Reconnect the server before connecting an event.");
    expect(errorMessage(undefined, "Could not subscribe. Try again.")).toBe(
      "Could not subscribe. Try again.",
    );
  });
});
