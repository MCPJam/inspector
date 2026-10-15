import { describe, expect, it, vi } from "vitest";
import { openChatDeepLink, resolveChatDeepLink } from "../chat-deep-links";
import { ThreadAppError } from "../thread-app-api";

const library = { kind: "global" as const, toolName: "library", title: "Library" };
const owner = (entries: Record<string, (typeof library)[]>) => ({
  servers: Object.keys(entries).map((serverId) => ({
    serverId,
    name: `${serverId} name`,
  })),
  entries,
  navigateDeepLink: vi.fn(async () => {}),
});
const link = "chatgpt://plugins/bits/app/library?path=%2Fparts%2F7";

describe("deep links written in chat", () => {
  it("opens the one plugin whose global App has the link's tool", async () => {
    const value = owner({ a: [library], b: [] });
    const report = vi.fn();
    await expect(openChatDeepLink(value, link, report)).resolves.toBe(true);
    expect(value.navigateDeepLink).toHaveBeenCalledWith(
      value.servers[0],
      link,
    );
    expect(report).not.toHaveBeenCalled();
  });

  it("describes invalid, unknown and ambiguous links instead of guessing", () => {
    expect(resolveChatDeepLink(owner({ a: [library] }), "chatgpt://x")).toEqual(
      {
        error:
          "This isn't a valid plugin link. It needs a plugin, an App tool and a path.",
      },
    );
    expect(
      resolveChatDeepLink(
        owner({ a: [] }),
        "codex://plugins/bits/app/other?path=%2F",
      ),
    ).toEqual({
      error: 'No plugin in this chat has a global App with the tool "other".',
    });
    expect(
      resolveChatDeepLink(owner({ a: [library], b: [library] }), link),
    ).toEqual({
      error:
        'Several plugins have a global App with the tool "library" (a name, b name). Open it from the Apps list instead.',
    });
  });

  it("reports a refused navigation in plain words", async () => {
    const value = owner({ a: [library] });
    const refusal = new ThreadAppError("INSTANCE_DEEP_LINK_UNAVAILABLE");
    value.navigateDeepLink.mockRejectedValue(refusal);
    const report = vi.fn();
    await expect(openChatDeepLink(value, link, report)).resolves.toBe(false);
    // The host's plain description, never the bare code.
    expect(report).toHaveBeenCalledWith(
      refusal.description ?? "No global App with that tool accepts this link.",
    );
    expect(report.mock.calls[0][0]).not.toMatch(/^[A-Z_]+$/);
  });
});

it("uses the host's resolver when it has one, so plugin aliases work", async () => {
  const value = {
    ...owner({ a: [library], b: [library] }),
    api: {
      resolveDeepLink: vi.fn(async () => ({
        serverId: "b",
        toolName: "library",
        url: "/parts/7",
      })),
    },
  };
  const report = vi.fn();
  await expect(openChatDeepLink(value, link, report)).resolves.toBe(true);
  expect(value.api.resolveDeepLink).toHaveBeenCalledWith(
    link,
    ["a", "b"],
    expect.any(AbortSignal),
  );
  expect(value.navigateDeepLink).toHaveBeenCalledWith(value.servers[1], link);
  value.api.resolveDeepLink.mockRejectedValueOnce(
    Object.assign(new Error("PLUGIN_DEEP_LINK_AMBIGUOUS"), {
      code: "PLUGIN_DEEP_LINK_AMBIGUOUS",
      description: "Two plugins answer to this link: A and B.",
    }),
  );
  await expect(openChatDeepLink(value, link, report)).resolves.toBe(false);
  expect(report).toHaveBeenCalledWith("Two plugins answer to this link: A and B.");
});

it("names the candidates of an ambiguous link", async () => {
  const value = {
    ...owner({ a: [library] }),
    api: {
      resolveDeepLink: vi.fn(async () => {
        throw new ThreadAppError("PLUGIN_DEEP_LINK_AMBIGUOUS", {
          description: "More than one installed plugin answers to this link.",
          candidates: ["Bits & Bolts", "Bits & Bolts (2)"],
        });
      }),
    },
  };
  const report = vi.fn();
  await expect(openChatDeepLink(value, link, report)).resolves.toBe(false);
  expect(report).toHaveBeenCalledWith(
    "More than one installed plugin answers to this link. (Bits & Bolts, Bits & Bolts (2))",
  );
});
