import { AsyncLocalStorage } from "node:async_hooks";
import {
  AuthorizedToolInvoker,
  PluginInvocationError,
  type PluginInvocationPorts,
  type PluginInvocationOrigin,
  type PluginToolCallParams,
  type TrustedInvocationOwner,
} from "./invocation.js";

/** Retain receipts, but never the credential/manager ports of a settled request. */
export class RequestOwnedToolInvoker {
  private readonly request = new AsyncLocalStorage<{
    ports?: PluginInvocationPorts;
  }>();
  private readonly invoker: AuthorizedToolInvoker;

  constructor(
    owner: TrustedInvocationOwner,
    assertLive: () => void,
    observe?: ConstructorParameters<typeof AuthorizedToolInvoker>[3],
  ) {
    const ports = () => {
      assertLive();
      const current = this.request.getStore()?.ports;
      if (!current) throw new PluginInvocationError("INSTANCE_REQUEST_MISSING");
      return current;
    };
    this.invoker = new AuthorizedToolInvoker(
      owner,
      {
        get receipts() {
          return ports().receipts;
        },
        get continuation() {
          return ports().continuation;
        },
        authorize: (...args) => ports().authorize(...args),
        approve: (...args) => ports().approve(...args),
        get admit() {
          // Preserve the trusted effect-free port identity without retaining
          // settled request ports. Wrapping it would invent an admission wait.
          return ports().admit;
        },
        get metadata() {
          if (!ports().metadata) return undefined;
          return (
            ...args: Parameters<NonNullable<PluginInvocationPorts["metadata"]>>
          ) => ports().metadata!(...args);
        },
        execute: (...args) => ports().execute(...args),
        classifyFailure: (error) => ports().classifyFailure(error),
      },
      2048,
      observe,
    );
  }

  invoke(
    ports: PluginInvocationPorts,
    origin: PluginInvocationOrigin,
    invocationId: string,
    params: PluginToolCallParams,
    signal?: AbortSignal,
  ) {
    const envelope: { ports?: PluginInvocationPorts } = { ports };
    return this.request.run(envelope, () =>
      this.invoker.invoke(origin, invocationId, params, signal).finally(() => {
        envelope.ports = undefined;
      }),
    );
  }

  close() {
    this.invoker.close();
  }
}
