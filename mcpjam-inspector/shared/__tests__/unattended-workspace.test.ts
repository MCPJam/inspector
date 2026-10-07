import { describe, expect, it } from "vitest";
import {
  projectWorkspaceTranscript,
  workspacePresentationHostConfig,
} from "../unattended-workspace";

describe("unattended transcript projection", () => {
  it("projects text and static placeholders without copying execution or private payloads", () => {
    expect(
      projectWorkspaceTranscript([
        { role: "system", content: "private prompt" },
        {
          role: "user",
          content: [
            { type: "text", text: "Open part" },
            { type: "image", image: "secret" },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Here" },
            { type: "tool-call", args: { secret: true } },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              output: { html: "<script>run()</script>", token: "secret" },
            },
          ],
        },
      ]),
    ).toEqual({
      messages: [
        { role: "user", text: "Open part" },
        { role: "assistant", text: "Here" },
        { role: "app" },
        { role: "app" },
      ],
    });
  });
  it("uses only the admitted appearance enum", () => {
    expect(
      projectWorkspaceTranscript([], { theme: "dark", html: "unsafe" }),
    ).toEqual({ messages: [], theme: "dark" });
    expect(projectWorkspaceTranscript([], { theme: "unsafe" })).toEqual({
      messages: [],
    });
  });
  it("projects saved host styling without copying config or credentials", () => {
    expect(
      projectWorkspaceTranscript(
        [],
        { theme: "dark" },
        { hostStyle: "chatgpt" },
      ),
    ).toEqual({ messages: [], theme: "dark", hostStyle: "chatgpt" });
    expect(
      projectWorkspaceTranscript([], undefined, { hostStyle: null }),
    ).toEqual({ messages: [] });
  });
  it("keeps saved host styling through a partial case override", () => {
    const config = workspacePresentationHostConfig(
      { hostStyle: "chatgpt", temperature: 1 },
      { temperature: 0 },
    );
    expect(projectWorkspaceTranscript([], undefined, config)).toEqual({
      messages: [],
      hostStyle: "chatgpt",
    });
    expect(
      workspacePresentationHostConfig(config, { hostStyle: null }).hostStyle,
    ).toBeNull();
  });
  it("bounds snapshots and rereads the current history without mutation", () => {
    const history = [{ role: "user", content: "x".repeat(9000) }];
    expect(projectWorkspaceTranscript(history).messages?.[0]).toEqual({
      role: "user",
      text: "x".repeat(8192),
    });
    history.push({ role: "assistant", content: "new" });
    expect(projectWorkspaceTranscript(history).messages).toHaveLength(2);
    expect(
      projectWorkspaceTranscript(Array(120).fill(history[0])).messages,
    ).toHaveLength(100);
    expect(history[0].content).toHaveLength(9000);
  });
});
