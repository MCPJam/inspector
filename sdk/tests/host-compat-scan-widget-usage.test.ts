import { describe, expect, it, vi } from "vitest";
import {
  scanWidgetUsage,
  type HostCompatToolsInput,
} from "../src/host-compat/index";

const widgetTool = (name: string, uri: string) => ({
  name,
  _meta: { "openai/outputTemplate": uri, ui: { resourceUri: uri } },
});

const htmlResource = (html: string) => ({
  contents: [{ text: html }],
});

describe("scanWidgetUsage", () => {
  it("returns undefined when tools aren't loaded", async () => {
    expect(await scanWidgetUsage(null, async () => ({}))).toBeUndefined();
    expect(
      await scanWidgetUsage(undefined as never, async () => ({})),
    ).toBeUndefined();
  });

  it("returns {} when no tool declares a widget", async () => {
    const tools: HostCompatToolsInput = { tools: [{ name: "plain" }] };
    expect(await scanWidgetUsage(tools, async () => ({}))).toEqual({});
  });

  it("scans widget HTML for the host APIs it calls", async () => {
    const tools: HostCompatToolsInput = {
      tools: [widgetTool("chart", "ui://chart")],
    };
    const usage = await scanWidgetUsage(tools, async () =>
      htmlResource("window.openai.sendFollowUpMessage('hi')"),
    );
    expect(usage).toEqual({ message: ["chart"] });
  });

  it("scans an OpenAI-only widget (openai/outputTemplate, no ui.resourceUri)", async () => {
    const tools: HostCompatToolsInput = {
      tools: [{ name: "card", _meta: { "openai/outputTemplate": "ui://card" } }],
    };
    const readResource = vi.fn(async () =>
      htmlResource("window.openai.sendFollowUpMessage()"),
    );
    const usage = await scanWidgetUsage(tools, readResource);
    expect(readResource).toHaveBeenCalledWith("ui://card");
    expect(usage).toEqual({ message: ["card"] });
  });

  it("reads each shared URI once; all tools inherit its needs", async () => {
    const tools: HostCompatToolsInput = {
      tools: [widgetTool("a", "ui://w"), widgetTool("b", "ui://w")],
    };
    const readResource = vi.fn(async () =>
      htmlResource("el.callTool('x')"),
    );
    const usage = await scanWidgetUsage(tools, readResource);
    expect(readResource).toHaveBeenCalledTimes(1);
    expect(usage).toEqual({ serverTools: ["a", "b"] });
  });

  it("returns undefined when every read fails (Unknown, not clean)", async () => {
    const tools: HostCompatToolsInput = {
      tools: [widgetTool("chart", "ui://chart")],
    };
    const usage = await scanWidgetUsage(tools, async () => {
      throw new Error("no resource");
    });
    expect(usage).toBeUndefined();
  });

  it("returns undefined when a read resolves with no content (not a clean {})", async () => {
    const tools: HostCompatToolsInput = {
      tools: [widgetTool("chart", "ui://chart")],
    };
    // Read resolves, but there's nothing to scan — must NOT read as clean.
    expect(await scanWidgetUsage(tools, async () => ({}))).toBeUndefined();
    expect(
      await scanWidgetUsage(tools, async () => ({ contents: [] })),
    ).toBeUndefined();
  });

  it("returns undefined when only some widgets could be analyzed", async () => {
    const tools: HostCompatToolsInput = {
      tools: [widgetTool("a", "ui://a"), widgetTool("b", "ui://b")],
    };
    // a reads cleanly; b can't be read → incomplete → Unknown, not partial.
    const usage = await scanWidgetUsage(tools, async (uri) =>
      uri === "ui://a"
        ? htmlResource("<div/>")
        : Promise.reject(new Error("unreadable")),
    );
    expect(usage).toBeUndefined();
  });

  it("honors toolsMetadata over inline _meta when collecting URIs", async () => {
    const tools: HostCompatToolsInput = {
      tools: [{ name: "chart" }],
      toolsMetadata: { chart: { ui: { resourceUri: "ui://meta" } } },
    };
    const readResource = vi.fn(async () => htmlResource("ui/message"));
    const usage = await scanWidgetUsage(tools, readResource);
    expect(readResource).toHaveBeenCalledWith("ui://meta");
    expect(usage).toEqual({ message: ["chart"] });
  });
});
