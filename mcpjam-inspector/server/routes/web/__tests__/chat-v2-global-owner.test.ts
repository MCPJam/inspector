import { describe, expect, it, vi } from "vitest";
import {
  globalOwnerAdmission,
  mergePluginContextMessages,
  withGlobalOwnerFallback,
} from "../chat-v2-global-owner.js";
import { PluginInvocationError } from "../../../services/plugin-host/invocation.js";
import type { PluginWorkspaceAdmission } from "../../../services/plugin-host/admission.js";

const chat = Object.freeze({
  actorId: "actor",
  projectId: "project",
  workspaceId: "playground:chat",
  revalidate: vi.fn(async () => {}),
});
const descriptor = { version: 1, workspaceId: "playground:global" };

describe("global owner binding for chat turns", () => {
  it("reuses the chat's member admission under the global namespace", async () => {
    const global = globalOwnerAdmission(chat, descriptor)!;
    expect(global).toMatchObject({
      actorId: "actor",
      projectId: "project",
      workspaceId: "playground:global",
    });
    await global.revalidate({ expectedActorId: "actor" });
    expect(chat.revalidate).toHaveBeenCalledWith({ expectedActorId: "actor" });
    expect(globalOwnerAdmission(undefined, descriptor)).toBeUndefined();
    expect(globalOwnerAdmission(chat, undefined)).toBeUndefined();
    expect(
      globalOwnerAdmission(chat, { version: 1, workspaceId: chat.workspaceId }),
    ).toBeUndefined();
    expect(() => globalOwnerAdmission(chat, { workspaceId: "x" })).toThrow();
  });

  it("merges both owners' context into one ephemeral user message", () => {
    const a = { role: "user" as const, content: [{ type: "text" as const, text: "a" }] };
    const b = { role: "user" as const, content: [{ type: "text" as const, text: "b" }] };
    expect(mergePluginContextMessages(undefined, undefined)).toBeUndefined();
    expect(mergePluginContextMessages(a, undefined)).toBe(a);
    expect(mergePluginContextMessages(a, b)).toEqual({
      role: "user",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ],
    });
  });

  it("tries the chat owner first and the global owner only after a refusal", async () => {
    const global = globalOwnerAdmission(chat, descriptor)!;
    const run = vi.fn(async (admission: PluginWorkspaceAdmission | undefined) => {
      if (admission === chat)
        throw new PluginInvocationError("INSTANCE_UNAVAILABLE");
      return admission?.workspaceId;
    });
    await expect(withGlobalOwnerFallback(run, chat, global)).resolves.toBe(
      "playground:global",
    );
    expect(run).toHaveBeenCalledTimes(2);
    // Without a global owner the chat's refusal stands.
    await expect(
      withGlobalOwnerFallback(run, chat, undefined),
    ).rejects.toBeInstanceOf(PluginInvocationError);
    // Other failures are never retried.
    const failing = vi.fn(async () => {
      throw new Error("network");
    });
    await expect(withGlobalOwnerFallback(failing, chat, global)).rejects.toThrow(
      "network",
    );
    expect(failing).toHaveBeenCalledTimes(1);
  });
});
