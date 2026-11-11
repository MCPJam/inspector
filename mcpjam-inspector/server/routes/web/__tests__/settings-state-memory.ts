import { parsePluginSettingsDocument } from "../../../../shared/plugin-settings";

/**
 * Stands in for `settings-state.ts` in route tests that mock the instance
 * registry: the document a settings read stores is kept per Settings App
 * handle, as the App's row would keep it. The replica tests use the real
 * module with a shared control store instead.
 */
export function memorySettingsState(
  getInstance: (token: string) => unknown,
) {
  const stored = new Map<string, unknown>();
  const children = new Map<string, { parent: unknown; action: string; revision: string }>();
  return {
    readPluginSettingsState: async (token: string) => ({
      instance: await getInstance(token),
      expiresAt: Date.now() + 60_000,
      version: stored.has(token) ? 1 : 0,
      document: stored.has(token)
        ? parsePluginSettingsDocument(stored.get(token))
        : undefined,
    }),
    storePluginSettingsDocument: async (
      token: string,
      _actor: unknown,
      _version: unknown,
      content: unknown,
    ) => {
      stored.set(token, content);
    },
    issuePluginSettingsChild: async (
      _token: string,
      _actor: unknown,
      state: { instance: unknown },
      app: { action: string; revision: string },
    ) => {
      const childToken = crypto.randomUUID();
      children.set(childToken, { parent: state.instance, ...app });
      return childToken;
    },
    readPluginSettingsChild: async (
      childToken: string,
      _actor: unknown,
      parent: unknown,
    ) => {
      const { PluginInvocationError } = await import(
        "../../../services/plugin-host/invocation"
      );
      const child = children.get(childToken);
      if (!child) throw new PluginInvocationError("INSTANCE_UNAVAILABLE");
      if (JSON.stringify(child.parent) !== JSON.stringify(parent))
        throw new PluginInvocationError("INSTANCE_DENIED");
      return child;
    },
    closePluginSettingsChild: async (childToken: string) => {
      children.delete(childToken);
    },
  };
}
