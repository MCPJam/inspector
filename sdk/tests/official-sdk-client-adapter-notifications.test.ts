import { describe, expect, it, vi } from "vitest";
import { createManagedMcpClient } from "../src/mcp-client-manager/managed-mcp-client-factory.js";
import { OfficialSdkClientAdapter } from "../src/mcp-client-manager/official-sdk-client-adapter.js";
import { TasksExtNotificationMethod } from "../src/mcp-client-manager/tasks-ext.js";
import { ResourceUpdatedNotificationMethod } from "../src/mcp-client-manager/subscription-coordinator.js";

const clientInfo = { name: "test", version: "0.0.0" };

function newAdapter(): OfficialSdkClientAdapter {
  return createManagedMcpClient({
    clientInfo,
    clientOptions: { capabilities: {} },
  }) as OfficialSdkClientAdapter;
}

/**
 * Reach the handler upstream actually stored, and invoke it the way the
 * protocol layer does. Going through the real `Client` is the point: the bug
 * this covers lived entirely in upstream's overload dispatch, so a fake client
 * would have passed while every `subscriptions/listen` failed.
 */
function storedHandler(
  adapter: OfficialSdkClientAdapter,
  method: string
): ((notification: unknown, codec: unknown) => Promise<unknown>) | undefined {
  return (
    adapter.inner as unknown as {
      _notificationHandlers: Map<
        string,
        (notification: unknown, codec: unknown) => Promise<unknown>
      >;
    }
  )._notificationHandlers.get(method);
}

describe("OfficialSdkClientAdapter.setNotificationHandler", () => {
  it("registers the tasks extension notification without throwing", () => {
    // Upstream 2.0.0 rejects the two-argument overload for any method outside
    // its two spec codecs, which broke every subscription the coordinator
    // opened — it registers this method unconditionally, task filter or not.
    const adapter = newAdapter();

    expect(() =>
      adapter.setNotificationHandler(TasksExtNotificationMethod, () => {})
    ).not.toThrow();
    expect(storedHandler(adapter, TasksExtNotificationMethod)).toBeDefined();
  });

  it("delivers the raw extension notification, params untouched", async () => {
    const adapter = newAdapter();
    const handler = vi.fn();
    adapter.setNotificationHandler(TasksExtNotificationMethod, handler);

    const notification = {
      method: TasksExtNotificationMethod,
      params: {
        taskId: "task-1",
        status: "completed",
        _meta: { "io.modelcontextprotocol/subscriptionId": "listen:0" },
      },
    };
    await storedHandler(adapter, TasksExtNotificationMethod)?.(
      notification,
      undefined
    );

    // The manager and coordinator read `notification.method` and the full
    // params (including extension-only members), so neither may be reshaped.
    expect(handler).toHaveBeenCalledWith(notification);
  });

  it("keeps spec notifications on the codec-validated path", async () => {
    const adapter = newAdapter();
    const handler = vi.fn();
    adapter.setNotificationHandler(ResourceUpdatedNotificationMethod, handler);

    const notification = {
      method: ResourceUpdatedNotificationMethod,
      params: { uri: "demo://counter" },
    };
    const codec = {
      validateNotification: vi.fn(() => ({ ok: true, value: notification })),
    };
    await storedHandler(adapter, ResourceUpdatedNotificationMethod)?.(
      notification,
      codec
    );

    expect(codec.validateNotification).toHaveBeenCalled();
    expect(handler).toHaveBeenCalledWith(notification);
  });
});
