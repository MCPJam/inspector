import { prepareCodexHome, type CodexHomeInput } from "./codex-home.js";
import { refreshNativeMcpServers } from "../shared/native-mcp.js";
import { waitForNativeMcpServers } from "./native-mcp-ready.js";

export type NativeMcpRuntime = {
  request(method: string, params?: unknown): Promise<unknown>;
  kill(): Promise<void>;
};
export type NativeMcpRefreshState = {
  runtime: NativeMcpRuntime;
  home: CodexHomeInput;
  threadId?: string;
};

/** Serialize credential refreshes without starting or resuming a model turn. */
export function createNativeMcpRefresher(options: {
  current(): NativeMcpRefreshState | undefined;
  commit(home: CodexHomeInput): void;
  invalidate(runtime: NativeMcpRuntime): Promise<void>;
}) {
  let tail: Promise<void> = Promise.resolve();
  return {
    settled: () => tail,
    refresh(candidate: unknown): Promise<void> {
      const pending = tail.then(async () => {
        const state = options.current();
        if (!state?.home.nativeMcpServers)
          throw new Error("No native MCP runtime to refresh");
        const servers = refreshNativeMcpServers(
          state.home.nativeMcpServers,
          candidate,
        );
        const next = { ...state.home, nativeMcpServers: servers };
        try {
          prepareCodexHome(next);
          await waitForNativeMcpServers({
            runtime: state.runtime,
            threadId: state.threadId,
            serverNames: Object.keys(servers),
            reload: true,
          });
          options.commit(next);
        } catch (error) {
          try {
            await state.runtime.kill();
          } finally {
            await options.invalidate(state.runtime);
          }
          throw error;
        }
      });
      // A definite validation refusal must not poison later refreshes. The
      // failed caller still receives its error; uncertain writes retire state.
      tail = pending.then(
        () => undefined,
        () => undefined,
      );
      return pending;
    },
  };
}
