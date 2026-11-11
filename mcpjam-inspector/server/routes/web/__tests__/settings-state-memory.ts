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
  return {
    readPluginSettingsState: async (token: string) => ({
      instance: await getInstance(token),
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
  };
}
