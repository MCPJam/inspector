import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PluginWorkspaceReplay,
  RecordedPluginWorkspace,
} from "../PluginWorkspaceReplay";
const id = "b83ebc97-291c-4b9e-bac0-c651fa4641aa";
const recording = {
  version: 1,
  runtime: "codex",
  sequence: 1,
  droppedEvents: 0,
  instances: [{ instanceId: id, generation: 1, visible: false }],
  events: [{ sequence: 1, kind: "opened", instanceId: id, generation: 1 }],
};
afterEach(() => vi.unstubAllGlobals());
describe("captured workspace replay", () => {
  it("renders v2 closed feature outcomes inertly without retaining execution inputs", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(
      <PluginWorkspaceReplay
        recording={{
          ...recording,
          version: 2,
          events: [
            {
              sequence: 1,
              kind: "call-completed",
              instanceId: recording.instances[0].instanceId,
              generation: 1,
              operationId: crypto.randomUUID(),
              feature: "file-write",
              fidelity: "observed",
              outcome: "conflict",
            },
          ],
        }}
      />,
    );
    const frame = screen.getByTitle("Recorded plugin workspace");
    expect(frame.getAttribute("srcdoc")).not.toContain("file-write");
    expect(frame.getAttribute("srcdoc")).not.toMatch(/<h1|<ol|<li/);
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame.getAttribute("srcdoc")).not.toMatch(
      /<script|operationId|file:\/\/|<form/,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("mounts no live widget/ports and never fetches when preloaded", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(
      <PluginWorkspaceReplay
        recording={recording}
        screenshotBase64={btoa("\x89PNG\r\n\x1a\n")}
      />,
    );
    const frame = screen.getByTitle("Recorded plugin workspace");
    expect(frame).toHaveAttribute("sandbox", "");
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(frame.getAttribute("srcdoc")).toContain("default-src 'none'");
    expect(frame).not.toHaveAttribute("src");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("diagnoses unknown versions without falling back to live app rendering", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(
      <RecordedPluginWorkspace
        recording={{ ...recording, version: 99 }}
        screenshotUrl="https://fixture.invalid/web/artifact?t=opaque"
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Unsupported workspace capture",
    );
    expect(screen.queryByTitle("Recorded plugin workspace")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses a plain URL before asset loading", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    render(
      <RecordedPluginWorkspace
        recording={recording}
        screenshotUrl="https://fixture.invalid/unowned.png"
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Captured image unavailable",
      ),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("loads an owned image outside replay and supplies only raster bytes", async () => {
    const bytes = Uint8Array.from(atob(btoa("\x89PNG\r\n\x1a\n")), (c) =>
      c.charCodeAt(0),
    );
    const fetch = vi.fn(async () => new Response(bytes));
    vi.stubGlobal("fetch", fetch);
    render(
      <RecordedPluginWorkspace
        recording={recording}
        screenshotUrl="https://fixture.invalid/web/artifact?t=opaque"
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByTitle("Recorded plugin workspace").getAttribute("srcdoc"),
      ).toContain("data:image/png;base64,"),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1]).toMatchObject({
      credentials: "omit",
      redirect: "error",
    });
    expect(
      screen.getByTitle("Recorded plugin workspace").getAttribute("srcdoc"),
    ).not.toContain("fixture.invalid");
  });
});
