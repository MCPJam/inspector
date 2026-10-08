import { describe, expect, it } from "vitest";
import { describePluginStatus, pluginStatusDotClass } from "../plugin-status";

describe("describePluginStatus", () => {
  const base = { enabled: true, activeVersionId: "pv_1" };

  it("is Active only when the active-plugins read says chats run it", () => {
    expect(
      describePluginStatus({ ...base, row: { status: "active" } }),
    ).toEqual({ label: "Active", tone: "active" });
    // A ready component alone never claims Active.
    expect(describePluginStatus({ ...base, readiness: "ready" }).label).toBe(
      "Ready",
    );
  });

  it("names the skip the member can act on", () => {
    expect(
      describePluginStatus({
        ...base,
        row: { status: "skipped", reason: "needs_auth" },
      }).label,
    ).toBe("Needs sign-in");
    expect(
      describePluginStatus({
        ...base,
        row: { status: "skipped", reason: "needs_setup" },
      }).label,
    ).toBe("Needs setup");
    expect(
      describePluginStatus({
        ...base,
        row: { status: "skipped", reason: "placement" },
      }).label,
    ).toBe("Skipped: can't run here");
    expect(
      describePluginStatus({
        ...base,
        row: { status: "skipped", reason: "some_new_reason" },
      }).label,
    ).toBe("Skipped: some new reason");
  });

  it("is Disabled whenever the plugin is off", () => {
    expect(
      describePluginStatus({
        ...base,
        enabled: false,
        row: { status: "active" },
      }).label,
    ).toBe("Disabled");
    expect(
      describePluginStatus({
        ...base,
        row: { status: "skipped", reason: "disabled" },
      }),
    ).toEqual({ label: "Disabled", tone: "muted" });
  });

  it("falls back to component readiness without an answer from the read", () => {
    expect(
      describePluginStatus({ ...base, readiness: "needs_auth" }).label,
    ).toBe("Needs sign-in");
    expect(
      describePluginStatus({ enabled: true, activeVersionId: null }).label,
    ).toBe("Not activated");
  });

  it("says an installed plugin with no active version is not activated", () => {
    expect(
      describePluginStatus({
        enabled: true,
        activeVersionId: null,
        row: { status: "skipped", reason: "no_active_version" },
      }),
    ).toEqual({ label: "Not activated", tone: "muted" });
    // A disabled one still says Disabled first.
    expect(
      describePluginStatus({ enabled: false, activeVersionId: null }).label,
    ).toBe("Disabled");
  });

  it("uses role tokens for the dot", () => {
    expect(pluginStatusDotClass("active")).toBe("bg-success");
    expect(pluginStatusDotClass("attention")).toBe("bg-warning");
    expect(pluginStatusDotClass("muted")).toBe("bg-muted-foreground");
  });
});
