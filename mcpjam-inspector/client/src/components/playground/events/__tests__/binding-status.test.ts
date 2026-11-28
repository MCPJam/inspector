import { describe, expect, it } from "vitest";
import { bindingStatus } from "../binding-status";
import type { PlaygroundEventBinding } from "../PlaygroundEventsProvider";

type Subscription = NonNullable<PlaygroundEventBinding["subscription"]>;

const watch = (
  observedState: Subscription["observedState"],
  enabled = true,
): Pick<PlaygroundEventBinding, "enabled" | "subscription"> => ({
  enabled,
  subscription: { observedState } as Subscription,
});

const connected = (feedStatus: string) => ({ connected: true, feedStatus });

describe("bindingStatus", () => {
  it("says Connecting while the server hasn't confirmed the subscription", () => {
    expect(bindingStatus(watch("pending"), connected("live"))).toBe(
      "Connecting",
    );
  });

  it("says Connecting while the live feed is opening", () => {
    expect(bindingStatus(watch("active"), connected("idle"))).toBe(
      "Connecting",
    );
    expect(bindingStatus(watch("active"), connected("connecting"))).toBe(
      "Connecting",
    );
  });

  it("says Listening once the feed is live or polling", () => {
    expect(bindingStatus(watch("active"), connected("live"))).toBe("Listening");
    expect(bindingStatus(watch("active"), connected("polling"))).toBe(
      "Listening",
    );
  });

  it("leaves every other state as it was", () => {
    expect(bindingStatus(watch("active"), connected("reconnecting"))).toBe(
      "reconnecting",
    );
    expect(bindingStatus(watch("active"), connected("error"))).toBe("error");
    expect(bindingStatus(watch("terminated"), connected("live"))).toBe(
      "terminated",
    );
    expect(bindingStatus(watch("paused_auth"), connected("live"))).toBe(
      "paused_auth",
    );
    expect(bindingStatus(watch("pending", false), connected("live"))).toBe(
      "Paused",
    );
    expect(
      bindingStatus(watch("pending"), { connected: false, feedStatus: "live" }),
    ).toBe("Disconnected");
    expect(
      bindingStatus(
        { enabled: true, subscription: undefined },
        connected("live"),
      ),
    ).toBe("Test only");
  });
});
