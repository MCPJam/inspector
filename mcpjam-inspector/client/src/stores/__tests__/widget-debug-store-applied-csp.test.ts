import { beforeEach, describe, expect, it } from "vitest";
import { useWidgetDebugStore } from "../widget-debug-store";

const HEADER =
  "default-src 'none'; connect-src https://api.example.com; frame-src 'none'";

const declared = {
  declaredDomain: null,
  mode: "widget-declared" as const,
  connectDomains: ["https://api.example.com"],
  resourceDomains: [],
  frameDomains: [],
  baseUriDomains: [],
  widgetDeclared: { connectDomains: ["https://api.example.com"] },
};

describe("widget-debug-store — applied CSP", () => {
  beforeEach(() => {
    useWidgetDebugStore.getState().clear();
  });

  it("merges the applied header into an existing csp record", () => {
    const store = useWidgetDebugStore.getState();
    store.setWidgetDebugInfo("t1", { toolName: "demo" });
    store.setWidgetCsp("t1", declared);
    store.addCspViolation("t1", {
      directive: "connect-src",
      blockedUri: "https://blocked.example.com/x",
      timestamp: 1,
    } as never);

    useWidgetDebugStore.getState().setWidgetAppliedCsp("t1", {
      mountId: 1,
      headerString: HEADER,
      mode: "widget-declared",
    });

    const csp = useWidgetDebugStore.getState().widgets.get("t1")!.csp!;
    expect(csp.headerString).toBe(HEADER);
    // Merge, not replace: the declared allowlists and the violations both
    // survive — the header arrives after them on every real mount.
    expect(csp.connectDomains).toEqual(["https://api.example.com"]);
    expect(csp.widgetDeclared).toEqual(declared.widgetDeclared);
    expect(csp.violations).toHaveLength(1);
  });

  it("records the proxy's own mode, which can differ from the declared one", () => {
    const store = useWidgetDebugStore.getState();
    store.setWidgetDebugInfo("t2", { toolName: "demo" });
    store.setWidgetCsp("t2", declared);

    useWidgetDebugStore
      .getState()
      .setWidgetAppliedCsp("t2", {
        mountId: 2,
        headerString: HEADER,
        mode: "permissive",
      });

    expect(useWidgetDebugStore.getState().widgets.get("t2")!.csp!.mode).toBe(
      "permissive",
    );
  });

  it("creates a record when the proxy reports before anything else does", () => {
    // A permissive widget declaring no csp/permissions/domain never reaches
    // setWidgetCsp at all, so this can be the first writer.
    useWidgetDebugStore.getState().setWidgetAppliedCsp("t3", {
      mountId: 3,
      headerString: HEADER,
      mode: "permissive",
    });

    const info = useWidgetDebugStore.getState().widgets.get("t3");
    expect(info).toBeDefined();
    expect(info!.csp!.headerString).toBe(HEADER);
    expect(info!.csp!.violations).toEqual([]);
    expect(info!.lifecycle).toEqual([]);
  });

  it("drops a stale header when new HTML is committed", () => {
    const store = useWidgetDebugStore.getState();
    store.setWidgetDebugInfo("t4", { toolName: "demo" });
    store.setWidgetAppliedCsp("t4", {
      mountId: 4,
      headerString: HEADER,
      mode: "widget-declared",
    });

    // A refetch commits fresh bytes: that mount's own mcpjam:csp-applied has
    // not arrived yet, and the previous mount's policy must not be presented
    // as what the proxy applied to HTML it never saw.
    useWidgetDebugStore.getState().setWidgetCsp("t4", declared);

    expect(
      useWidgetDebugStore.getState().widgets.get("t4")!.csp!.headerString,
    ).toBeUndefined();
  });

  it("keeps policies from different mounts separate", () => {
    const store = useWidgetDebugStore.getState();
    store.setWidgetAppliedCsp("t5", {
      mountId: 1,
      headerString: "frame-src https://one.example",
      mode: "widget-declared",
    });
    store.setWidgetAppliedCsp("t5", {
      mountId: 2,
      headerString: "frame-src https://two.example",
      mode: "widget-declared",
    });

    const csp = useWidgetDebugStore.getState().widgets.get("t5")!.csp!;
    expect(csp.activeMountId).toBe(2);
    expect(csp.appliedPoliciesByMount).toEqual({
      "1": {
        headerString: "frame-src https://one.example",
        mode: "widget-declared",
      },
      "2": {
        headerString: "frame-src https://two.example",
        mode: "widget-declared",
      },
    });
  });
});
