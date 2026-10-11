import { describe, expect, it, vi } from "vitest";
import type { WidgetHost } from "@mcpjam/widget-react";
import { withAppContext } from "../use-app-context";
import { withAppMessages } from "../app-message";
import type { ThreadAppHandle } from "../thread-app-api";
const host = (enabled: boolean) =>
  ({
    environment: {},
    services: {},
    resolvers: {
      resolveEffectiveHostCapabilities: () =>
        enabled ? { message: {}, updateModelContext: {} } : {},
      resolveEffectiveMcpAppsCapabilities: () => ({
        message: enabled,
        updateModelContext: enabled,
        hostContextChanged: enabled,
      }),
    },
  } as unknown as WidgetHost);
const handle = {
  contextEnabled: true,
  messageEnabled: true,
} as ThreadAppHandle;
describe("owned composer capability advertisement", () => {
  it.each([false, true])(
    "preserves native policy (%s) and advertises extension semantics only with actual ports",
    (enabled) => {
      const policy = host(enabled),
        owned = host(false);
      const context = withAppContext(owned, policy, handle, {
        snapshot: { revision: 0, sequence: 0, state: null },
        update: vi.fn() as never,
      });
      const composed = withAppMessages(context, policy, handle, {
        threadId: "thread",
        isLive: () => true,
        send: vi.fn(),
      });
      const caps = composed.resolvers.resolveEffectiveHostCapabilities(
        {} as never,
      );
      expect(caps.experimental?.["openai/modelContext"]).toEqual(
        enabled ? {} : undefined,
      );
      expect(caps.experimental?.["openai/message"]).toEqual(
        enabled ? {} : undefined,
      );
      expect(
        composed.resolvers.resolveEffectiveMcpAppsCapabilities({} as never)
          .message,
      ).toBe(enabled);
      expect(
        composed.environment.draftHostContext?.["openai/modelContext"],
      ).toBeNull();
    },
  );
});
