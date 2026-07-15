import { describe, expect, it } from "vitest";
import {
  getPlatformWidgetView,
  tagPlatformWidgetPayload,
} from "../src/shared/platform-widgets.js";

const PROJECT = { id: "project-1", name: "Project One", organizationId: "o" };

describe("getPlatformWidgetView", () => {
  it("recognizes tagged payloads that carry the view's envelope", () => {
    expect(
      getPlatformWidgetView(
        tagPlatformWidgetPayload("servers", { project: PROJECT, servers: [] })
      )
    ).toBe("servers");
    expect(
      getPlatformWidgetView(
        tagPlatformWidgetPayload("eval_suites", {
          project: PROJECT,
          items: [],
          otherProjects: [],
        })
      )
    ).toBe("eval_suites");
    expect(
      getPlatformWidgetView(
        tagPlatformWidgetPayload("eval_run", {
          project: PROJECT,
          run: { id: "run-1", status: "completed" },
        })
      )
    ).toBe("eval_run");
    expect(
      getPlatformWidgetView(
        tagPlatformWidgetPayload("chatbox", {
          project: PROJECT,
          chatbox: { id: "chatbox-1", name: "Support" },
        })
      )
    ).toBe("chatbox");
  });

  it("rejects non-objects and unknown tags", () => {
    expect(getPlatformWidgetView(undefined)).toBeUndefined();
    expect(getPlatformWidgetView("eval_suites")).toBeUndefined();
    expect(getPlatformWidgetView([])).toBeUndefined();
    expect(getPlatformWidgetView({ widget: "nope" })).toBeUndefined();
    expect(getPlatformWidgetView({ project: PROJECT })).toBeUndefined();
  });

  it("rejects prototype keys masquerading as view tags", () => {
    expect(getPlatformWidgetView({ widget: "toString" })).toBeUndefined();
    expect(getPlatformWidgetView({ widget: "constructor" })).toBeUndefined();
    expect(getPlatformWidgetView({ widget: "hasOwnProperty" })).toBeUndefined();
  });

  it("rejects tagged payloads whose envelope is malformed", () => {
    // items missing entirely.
    expect(
      getPlatformWidgetView({ widget: "chatboxes", project: PROJECT })
    ).toBeUndefined();
    // items present but not an array.
    expect(
      getPlatformWidgetView({
        widget: "eval_run_iterations",
        project: PROJECT,
        items: "not-a-list",
      })
    ).toBeUndefined();
    // run is a scalar.
    expect(
      getPlatformWidgetView({
        widget: "eval_run",
        project: PROJECT,
        run: "run-1",
      })
    ).toBeUndefined();
    // suite envelope absent on the runs view.
    expect(
      getPlatformWidgetView({
        widget: "eval_suite_runs",
        project: PROJECT,
        items: [],
      })
    ).toBeUndefined();
  });
});
