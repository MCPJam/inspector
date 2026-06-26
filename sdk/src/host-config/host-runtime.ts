/**
 * `HostRuntime` — live binding of a `Host` to an `MCPClientManager`.
 *
 * `Host` is a pure, serializable spec; `HostRunner` is a sync executor with
 * tools pre-resolved. `HostRuntime` sits between them: it holds a live
 * `Host` reference plus a structural manager and, on every `.run(...)`,
 * snapshots the host, validates server ids against the manager, resolves
 * the active tool set, and delegates to a fresh `HostRunner` constructed
 * with that snapshot.
 *
 * Bundle safety: this module deliberately avoids static imports of
 * `HostRunner`, `ai`, or `MCPClientManager`. The runner is dynamically
 * imported inside `.run()` so the `host-config` browser bundle remains
 * free of the AI SDK and Node-only runtime dependencies.
 *
 * Stateless across turns: `.run()` calls do NOT auto-replay prior turns
 * into the next runner. Conversation continuity stays explicit through
 * `PromptOptions.context`. The runtime accumulates `PromptResult` history
 * for inspection/reporting only.
 */

import type { HostExecutor, PromptOptions } from "../HostExecutor.js";
import type { PromptResult } from "../PromptResult.js";
import type { CustomProvider } from "../types.js";
import type { MCPServerReplayConfig } from "../eval-reporting-types.js";
import {
  assertHostServersKnown,
  resolveKnownServerIds,
  type Host,
  type HostServerRegistry,
} from "./host.js";
import { extractHostExecutionPolicy } from "./internal.js";
import type { HostJson } from "./public-types.js";

/**
 * Structural shape of the AI SDK tool record returned by
 * `MCPClientManager.getToolsForAiSdk()`. Kept narrow so this module does
 * not import `ai` types.
 */
type AiSdkToolRecord = Record<string, unknown>;

/**
 * Structural shape of an MCP client manager from `HostRuntime`'s point of
 * view: server registry + tool resolution. Both `MCPClientManager` and
 * lightweight test fakes satisfy this without dragging the concrete class
 * into this bundle-safe module.
 */
export type HostRuntimeManager = HostServerRegistry & {
  getToolsForAiSdk(
    serverIds?: string[] | string,
    options?: {
      includeAppOnly?: boolean;
      needsApproval?: boolean;
      modelVisibleMcpImageToolResults?: boolean;
    },
  ): Promise<AiSdkToolRecord>;
  /**
   * Optional. When the runtime is bound to a manager that exposes
   * replayable server configs (the concrete `MCPClientManager` does),
   * `HostRuntime.getServerReplayConfigs()` delegates here so SDK eval
   * uploads (`EvalTest`/`EvalSuite` -> `resolveServerReplayConfigs`) can
   * stamp them without callers manually copying configs into
   * `mcpjam.serverReplayConfigs`.
   */
  getServerReplayConfigs?(): MCPServerReplayConfig[] | undefined;
};

/**
 * Defaults bound at `HostRuntime` construction and applied to every `.run()`.
 *
 * `apiKey` is required because every `.run()` constructs a fresh `HostRunner`
 * and the runner requires it. The remaining fields override the corresponding
 * host-snapshot-derived values when set.
 */
export interface HostRuntimeDefaults {
  apiKey: string;
  /** Overrides the host snapshot's model. */
  model?: string;
  /** Overrides the host snapshot's systemPrompt. */
  systemPrompt?: string;
  /** Overrides the host snapshot's temperature. */
  temperature?: number;
  maxSteps?: number;
  customProviders?:
    | Map<string, CustomProvider>
    | Record<string, CustomProvider>;
  /** Overrides the host-config-resolved OpenAI compat decision. */
  injectOpenAiCompat?: boolean;
}

/**
 * Minimal `HostRunner` shape — anything `HostRuntime.run()` needs from the
 * dynamically-imported runner. Matches the real `HostRunner`'s public
 * surface for `run`, history, and snapshot access.
 */
type HostRunnerLike = HostExecutor;

/**
 * Live binding of a `Host` to an `MCPClientManager`. Construct via
 * `host.withManager(manager, { apiKey })` or the explicit constructor.
 */
export class HostRuntime implements HostExecutor {
  private readonly host: Host;
  private readonly manager: HostRuntimeManager;
  private readonly defaults: HostRuntimeDefaults;
  private promptHistory: PromptResult[] = [];

  constructor(
    host: Host,
    manager: HostRuntimeManager,
    defaults: HostRuntimeDefaults,
  ) {
    this.host = host;
    this.manager = manager;
    this.defaults = defaults;
  }

  /**
   * Execute the host against `input`. Snapshots the live `Host` on every
   * call so mutations between `.run()` invocations are reflected.
   *
   * Stateless across turns: prior `PromptResult`s are recorded in
   * {@link getPromptHistory} for inspection but NOT auto-replayed.
   * Conversation continuity stays explicit — caller passes `context: r1`
   * via `options` for follow-up turns.
   */
  async run(
    input: string,
    options?: PromptOptions,
  ): Promise<PromptResult> {
    const hostSnapshot = this.host.toJSON();
    assertHostServersKnown(hostSnapshot, this.manager);

    const policy = extractHostExecutionPolicy(
      hostSnapshot as unknown as Record<string, unknown>,
    );
    const serverIds = resolveKnownServerIds(hostSnapshot, this.manager);
    const tools = await this.manager.getToolsForAiSdk(serverIds, {
      includeAppOnly: policy.respectToolVisibility === false,
      modelVisibleMcpImageToolResults:
        policy.modelVisibleMcpImageToolResults,
    });

    // Dynamic import keeps `host-config` browser-safe: `HostRunner` pulls
    // in `ai` and other Node-leaning deps that must not leak into a
    // browser bundle that only consumed `host-config`.
    const runnerModule = await import("../HostRunner.js");
    const HostRunner = runnerModule.HostRunner;

    const runner: HostRunnerLike = new HostRunner({
      host: hostSnapshot,
      tools: tools as never,
      apiKey: this.defaults.apiKey,
      mcpClientManager: this.manager as never,
      customProviders: this.defaults.customProviders,
      maxSteps: this.defaults.maxSteps,
      systemPrompt: this.defaults.systemPrompt,
      temperature: this.defaults.temperature,
      model: this.defaults.model,
      injectOpenAiCompat: this.defaults.injectOpenAiCompat,
    });

    const result = await runner.run(input, options);
    this.promptHistory.push(result);
    return result;
  }

  /**
   * Return a new `HostRuntime` bound to the same `host` and `manager` with
   * `defaults` shallow-merged. The new runtime has its own (empty) prompt
   * history, matching `HostRunner.withOptions(...)` semantics.
   */
  withOptions(
    options: Partial<HostRuntimeDefaults> | Record<string, any>,
  ): HostRuntime {
    return new HostRuntime(this.host, this.manager, {
      ...this.defaults,
      ...(options as Partial<HostRuntimeDefaults>),
    });
  }

  getPromptHistory(): PromptResult[] {
    return [...this.promptHistory];
  }

  resetPromptHistory(): void {
    this.promptHistory = [];
  }

  /**
   * Snapshot of the bound `Host` taken at call time. Useful for reporters
   * that want to stamp the current host config into per-iteration metadata.
   */
  getHostSnapshot(): HostJson {
    return this.host.toJSON();
  }

  /**
   * Delegate to the bound manager so SDK eval uploads
   * (`EvalTest`/`EvalSuite` -> `resolveServerReplayConfigs`) can infer
   * replay configs from the runtime, matching the `HostRunner` shape.
   * Returns `undefined` when the manager doesn't expose
   * `getServerReplayConfigs` (custom structural managers).
   */
  getServerReplayConfigs(): MCPServerReplayConfig[] | undefined {
    return this.manager.getServerReplayConfigs?.();
  }
}
