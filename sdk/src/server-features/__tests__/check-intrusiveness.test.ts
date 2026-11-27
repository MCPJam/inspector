import { describe, expect, it } from "vitest";
import { MCP_CHECK_IDS } from "../../mcp-conformance/types.js";
import { MCP_APPS_CHECK_IDS } from "../../apps-conformance/types.js";
import {
  MCP_TASKS_CHECK_IDS,
  MCP_TASKS_TOOL_CHECK_IDS,
} from "../../tasks-conformance/types.js";
import {
  EVENTS_CHECK_IDS,
  EVENTS_WEBHOOK_CHECK_IDS,
} from "../../events-conformance/types.js";
import { CONFORMANCE_CHECK_METADATA } from "../../oauth-conformance/types.js";
import { TRANSPORT_CHECK_METADATA } from "../../mcp-conformance/checks/transport.js";
import { SUBSCRIPTION_CHECK_IDS } from "../../mcp-conformance/checks/modern.js";
import {
  APPS_CHECK_INTRUSIVENESS,
  BackgroundCheckRefusedError,
  EVENTS_CHECK_INTRUSIVENESS,
  OAUTH_CHECK_INTRUSIVENESS,
  PROTOCOL_CHECK_INTRUSIVENESS,
  TASKS_CHECK_INTRUSIVENESS,
  assertBackgroundSafeCheck,
  checkIntrusiveness,
  isBackgroundSafeCheck,
} from "../check-intrusiveness.js";

const sorted = (values: Iterable<string>) => [...values].sort();

describe("check intrusiveness", () => {
  it("covers every check id of every suite and nothing else", () => {
    expect(sorted(Object.keys(PROTOCOL_CHECK_INTRUSIVENESS))).toEqual(
      sorted(MCP_CHECK_IDS),
    );
    expect(sorted(Object.keys(APPS_CHECK_INTRUSIVENESS))).toEqual(
      sorted(MCP_APPS_CHECK_IDS),
    );
    expect(sorted(Object.keys(TASKS_CHECK_INTRUSIVENESS))).toEqual(
      sorted(MCP_TASKS_CHECK_IDS),
    );
    expect(sorted(Object.keys(EVENTS_CHECK_INTRUSIVENESS))).toEqual(
      sorted(EVENTS_CHECK_IDS),
    );
    expect(sorted(Object.keys(OAUTH_CHECK_INTRUSIVENESS))).toEqual(
      sorted(Object.keys(CONFORMANCE_CHECK_METADATA)),
    );
  });

  it("marks every check that calls a tool or creates a task side-effecting", () => {
    for (const id of MCP_TASKS_TOOL_CHECK_IDS) {
      expect(checkIntrusiveness(`tasks:${id}`)).toBe("side-effecting");
    }
    // The protocol checks the Inspector's PROBE_CHECKS name a tool for.
    for (const id of [
      "modern-logs-require-log-level",
      "modern-undeclared-capability-error",
      "modern-tool-output-schema-conformant",
    ]) {
      expect(checkIntrusiveness(`protocol:${id}`)).toBe("side-effecting");
    }
  });

  it("marks webhook, subscription, raw transport and extra-session checks side-effecting", () => {
    for (const id of EVENTS_WEBHOOK_CHECK_IDS) {
      expect(checkIntrusiveness(`events:${id}`)).toBe("side-effecting");
    }
    for (const id of SUBSCRIPTION_CHECK_IDS) {
      expect(checkIntrusiveness(`protocol:${id}`)).toBe("side-effecting");
    }
    for (const id of Object.keys(TRANSPORT_CHECK_METADATA)) {
      expect(checkIntrusiveness(`protocol:${id}`)).toBe("side-effecting");
    }
    for (const id of [
      "completion-complete",
      "logging-set-level",
      "localhost-host-rebinding-rejected",
      // Both send their own initialize, which opens a session.
      "localhost-host-valid-accepted",
      "protocol-invalid-method-error",
      "modern-protocol-version-header-mismatch",
      "modern-method-header-mismatch",
      "modern-name-header-mismatch",
      "modern-missing-method-header-rejected",
      "modern-header-names-case-insensitive",
      "modern-unsupported-version-error",
      "modern-removed-methods-not-found",
    ]) {
      expect(checkIntrusiveness(`protocol:${id}`)).toBe("side-effecting");
    }
  });

  it("lets the background probes grade Apps and the read-only Events checks", () => {
    for (const id of MCP_APPS_CHECK_IDS) {
      expect(isBackgroundSafeCheck(`apps:${id}`)).toBe(true);
    }
    expect(isBackgroundSafeCheck("events:events-capability-declared")).toBe(true);
    expect(isBackgroundSafeCheck("events:events-list-shape")).toBe(true);
    expect(isBackgroundSafeCheck("events:events-poll-null-cursor")).toBe(false);
  });

  it("refuses side-effecting and unknown checks", () => {
    expect(isBackgroundSafeCheck("tasks:tasks-inline-result")).toBe(false);
    expect(isBackgroundSafeCheck("protocol:not-a-check")).toBe(false);
    expect(isBackgroundSafeCheck("oauth:oauth_invalid_client")).toBe(false);
    expect(() => assertBackgroundSafeCheck("protocol:completion-complete")).toThrow(
      BackgroundCheckRefusedError,
    );
    expect(() => assertBackgroundSafeCheck("apps:ui-resources-readable")).not.toThrow();
  });
});
