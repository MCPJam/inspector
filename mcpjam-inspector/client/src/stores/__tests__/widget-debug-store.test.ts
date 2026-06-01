import { beforeEach, describe, expect, it } from "vitest";
import {
  useWidgetDebugStore,
  type WidgetLifecycleEvent,
  type WidgetSandboxApplied,
} from "../widget-debug-store";

describe("widget-debug-store — sandbox + lifecycle", () => {
  beforeEach(() => {
    useWidgetDebugStore.getState().clear();
  });

  describe("setSandboxApplied", () => {
    it("creates a minimal record when none exists", () => {
      const applied: WidgetSandboxApplied = {
        sandboxAttrs: ["allow-popups"],
        allowFeatures: { camera: "*" },
        permissive: false,
        hostPolicyApplied: true,
      };
      useWidgetDebugStore
        .getState()
        .setSandboxApplied("tool-1", applied, "host-profile-abc");

      const info = useWidgetDebugStore.getState().widgets.get("tool-1");
      expect(info).toBeDefined();
      expect(info!.toolCallId).toBe("tool-1");
      expect(info!.applied).toEqual(applied);
      expect(info!.hostProfileId).toBe("host-profile-abc");
      // The minimal record must include the lifecycle array so consumers
      // never see `undefined` and have to special-case it.
      expect(info!.lifecycle).toEqual([]);
      expect(info!.protocol).toBe("mcp-apps");
    });

    it("merges into an existing record without clobbering preserved fields", () => {
      // First the renderer publishes a lifecycle event (typical race —
      // logWidgetDebug fires before setWidgetDebugInfo settles).
      useWidgetDebugStore.getState().appendLifecycle("tool-2", {
        kind: "widget-content-requested",
        status: "pending",
        timestamp: 1000,
      });
      // Then the resolver settles.
      const applied: WidgetSandboxApplied = {
        cspDirectives: { "script-src": ["'unsafe-eval'"] },
        permissive: true,
        hostPolicyApplied: false,
      };
      useWidgetDebugStore.getState().setSandboxApplied("tool-2", applied);

      const info = useWidgetDebugStore.getState().widgets.get("tool-2");
      expect(info!.applied).toEqual(applied);
      expect(info!.lifecycle).toHaveLength(1);
      expect(info!.lifecycle[0]).toMatchObject({
        kind: "widget-content-requested",
      });
    });
  });

  describe("appendLifecycle", () => {
    const baseEvent: WidgetLifecycleEvent = {
      kind: "sandbox-proxy-ready",
      status: "ok",
      timestamp: 100,
    };

    it("creates a minimal record when none exists and seeds lifecycle", () => {
      useWidgetDebugStore.getState().appendLifecycle("tool-3", baseEvent);

      const info = useWidgetDebugStore.getState().widgets.get("tool-3");
      expect(info).toBeDefined();
      expect(info!.lifecycle).toEqual([baseEvent]);
      expect(info!.protocol).toBe("mcp-apps");
    });

    it("pushes events of a different kind", () => {
      const store = useWidgetDebugStore.getState();
      store.appendLifecycle("tool-4", baseEvent);
      store.appendLifecycle("tool-4", {
        kind: "widget-content-ready",
        status: "ok",
        timestamp: 200,
      });

      const info = useWidgetDebugStore.getState().widgets.get("tool-4");
      expect(info!.lifecycle.map((e) => e.kind)).toEqual([
        "sandbox-proxy-ready",
        "widget-content-ready",
      ]);
    });

    it("dedupes consecutive same-kind same-status events", () => {
      const store = useWidgetDebugStore.getState();
      store.appendLifecycle("tool-5", {
        kind: "bridge-connect-error",
        status: "error",
        message: "first attempt failed",
        timestamp: 100,
      });
      store.appendLifecycle("tool-5", {
        kind: "bridge-connect-error",
        status: "error",
        message: "second attempt failed",
        timestamp: 200,
      });
      store.appendLifecycle("tool-5", {
        kind: "bridge-connect-error",
        status: "error",
        message: "third attempt failed",
        timestamp: 300,
      });

      const info = useWidgetDebugStore.getState().widgets.get("tool-5");
      expect(info!.lifecycle).toHaveLength(1);
      expect(info!.lifecycle[0]).toMatchObject({
        kind: "bridge-connect-error",
        status: "error",
        message: "third attempt failed",
        timestamp: 300,
      });
    });

    it("does not dedupe when status differs even with same kind", () => {
      const store = useWidgetDebugStore.getState();
      store.appendLifecycle("tool-6", {
        kind: "bridge-connect-start",
        status: "pending",
        timestamp: 100,
      });
      store.appendLifecycle("tool-6", {
        kind: "bridge-connect-start",
        status: "ok",
        timestamp: 200,
      });

      const info = useWidgetDebugStore.getState().widgets.get("tool-6");
      expect(info!.lifecycle).toHaveLength(2);
    });
  });
});
