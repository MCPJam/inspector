import type { LocalDiscoveryBudget } from "../daemon/webmcp-bridge.js";
/** Local-only policy. Pages never provide controller addresses or exceptions. */
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { getInspectorFrontendUrl } from "../../../utils/inspector-frontend-url.js";
import type { DriverContext, DriverPage } from "../daemon/browser-page.js";

export class BrowserPolicyError extends Error {
  readonly code = "browser_policy_refused";
  constructor(message = "Browser access to this destination is not allowed.") {
    super(`browser_policy_refused: ${message}`);
    this.name = "BrowserPolicyError";
  }
}

const controllerPorts = new Map<number, number>();
const controllerOrigins = new Map<string, number>();
export function registerBrowserController(url: string): () => void {
  const parsed = new URL(url);
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  controllerOrigins.set(
    parsed.origin,
    (controllerOrigins.get(parsed.origin) ?? 0) + 1,
  );
  const local = isMachineAddress(parsed.hostname);
  if (local) controllerPorts.set(port, (controllerPorts.get(port) ?? 0) + 1);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    for (const [map, key] of [
      [controllerOrigins, parsed.origin],
      [controllerPorts, port],
    ] as const) {
      if (map === controllerPorts && !local) continue;
      const registry = map as Map<string | number, number>;
      const count = registry.get(key) ?? 0;
      if (count <= 1) registry.delete(key);
      else registry.set(key, count - 1);
    }
  };
}
function host(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}
export function isMachineAddress(raw: string): boolean {
  const value = host(raw);
  if (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value === "::1" ||
    value === "::" ||
    value === "0.0.0.0" ||
    /^127\./.test(value)
  )
    return true;
  if (value.startsWith("::ffff:")) {
    const tail = value.slice(7);
    if (tail.includes(".")) return isMachineAddress(tail);
    const parts = tail.split(":");
    if (parts.length === 2 && parts.every((p) => /^[\da-f]{1,4}$/.test(p))) {
      const first = parseInt(parts[0], 16),
        last = parseInt(parts[1], 16);
      return isMachineAddress(
        `${first >> 8}.${first & 255}.${last >> 8}.${last & 255}`,
      );
    }
  }
  return Object.values(networkInterfaces())
    .flat()
    .some((a) => a && host(a.address) === value);
}

export interface LocalBrowserSecurityPolicy {
  discoveryBudget: LocalDiscoveryBudget;
  assertNavigation(url: string): void;
  allowsRequest(url: string): boolean;
  resolveDestination(
    hostname: string,
    port: number,
  ): Promise<Array<{ address: string; family: number }>>;
  assertActive(): Promise<void>;
  isActive(): boolean;
  dispose?(): void;
  onRevoked(callback: () => void | Promise<void>): () => void;
}
export function createLocalBrowserSecurityPolicy(
  options: {
    assertActive?: () => Promise<void>;
    isActive?: () => boolean;
    onRevoked?: LocalBrowserSecurityPolicy["onRevoked"];
    dispose?: () => void;
    onAudit?: (counts: {
      navigationRefused: number;
      networkRefused: number;
      destinationRefused: number;
    }) => void;
    controllerUrls?: string[];
    lookup?: typeof lookup;
  } = {},
): LocalBrowserSecurityPolicy {
  const counts = {
    navigationRefused: 0,
    networkRefused: 0,
    destinationRefused: 0,
  };
  const increment = (key: keyof typeof counts) => {
    counts[key] = Math.min(1_000_000, counts[key] + 1);
  };
  const denyNetwork = () => {
    increment("networkRefused");
    return false;
  };
  const navigationError = (message: string) => {
    increment("navigationRefused");
    return new BrowserPolicyError(message);
  };
  const destinationError = () => {
    increment("destinationRefused");
    return new BrowserPolicyError();
  };
  let disposed = false;
  const supplied = options.controllerUrls;
  const registrations: Array<() => void> = [];
  if (supplied)
    for (const url of supplied)
      registrations.push(registerBrowserController(url));
  else {
    registrations.push(
      registerBrowserController(
        `http://127.0.0.1:${process.env.SERVER_PORT || 6274}`,
      ),
    );
    registrations.push(registerBrowserController(getInspectorFrontendUrl()));
  }
  const resolve = options.lookup ?? lookup;
  const aliases = (process.env.MCPJAM_ALLOWED_HOSTS || "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  function deniedHost(name: string, port: number): boolean {
    if (!controllerPorts.has(port)) return false;
    return (
      isMachineAddress(name) ||
      aliases.some((pattern) =>
        new RegExp(
          `^${pattern
            .split("*")
            .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*")}$`,
          "i",
        ).test(name),
      )
    );
  }
  const active = options.isActive ?? (() => true);
  const assertActive = options.assertActive ?? (async () => {});
  const policy: LocalBrowserSecurityPolicy = {
    discoveryBudget: { entries: new Map() },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      try {
        options.onAudit?.({ ...counts });
      } catch {
        /* metrics cannot break teardown */
      }
      registrations.forEach((remove) => remove());
      options.dispose?.();
    },
    assertActive,
    isActive: active,
    onRevoked: options.onRevoked ?? (() => () => {}),
    assertNavigation(raw) {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw navigationError(
          "Browser navigation requires an HTTP or HTTPS URL.",
        );
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !policy.allowsRequest(url.href)
      )
        throw navigationError(
          "Browser navigation requires an allowed HTTP or HTTPS website.",
        );
    },
    allowsRequest(raw) {
      if (!active()) return denyNetwork();
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return denyNetwork();
      }
      if (
        [
          "file:",
          "javascript:",
          "chrome:",
          "chrome-extension:",
          "devtools:",
        ].includes(url.protocol)
      )
        return denyNetwork();
      if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol))
        return (
          ["about:", "blob:", "data:"].includes(url.protocol) || denyNetwork()
        );
      const port = Number(
        url.port || (["https:", "wss:"].includes(url.protocol) ? 443 : 80),
      );
      const origin = `${
        url.protocol === "ws:"
          ? "http:"
          : url.protocol === "wss:"
          ? "https:"
          : url.protocol
      }//${url.host}`;
      return (
        (!controllerOrigins.has(origin) &&
          !deniedHost(host(url.hostname), port)) ||
        denyNetwork()
      );
    },
    async resolveDestination(name, port) {
      await assertActive();
      if (
        !Number.isInteger(port) ||
        port < 1 ||
        port > 65535 ||
        deniedHost(host(name), port)
      )
        throw destinationError();
      const addresses = isIP(host(name))
        ? [{ address: host(name), family: isIP(host(name)) }]
        : await resolve(host(name), { all: true, verbatim: true });
      if (
        !addresses.length ||
        addresses.some((a) => deniedHost(a.address, port))
      )
        throw destinationError();
      await assertActive();
      return addresses;
    },
  };
  return policy;
}

/** Preserve the driver interface, while checking authorization at actual dispatch. */
export function secureDriverContext(
  context: DriverContext,
  policy: LocalBrowserSecurityPolicy,
): DriverContext {
  const pages = new WeakMap<DriverPage, DriverPage>();
  let closed = false;
  let stop: (() => void) | undefined;
  const close = async () => {
    if (closed) return;
    closed = true;
    stop?.();
    try {
      await context.close();
    } finally {
      policy.dispose?.();
    }
  };
  stop = policy.onRevoked(close);
  function guard(page: DriverPage): DriverPage {
    const existing = pages.get(page);
    if (existing) return existing;
    const synchronous = new Set([
      "url",
      "isClosed",
      "consoleEntries",
      "consoleCursor",
      "dropConsoleSince",
      "networkEntries",
      "networkCursor",
      "dropNetworkSince",
      "pendingDialog",
    ]);
    const wrapped = new Proxy(page, {
      get(target, key) {
        const value = Reflect.get(target, key);
        if (typeof value !== "function") return value;
        if (key === "close" || key === "isClosed") return value.bind(target);
        if (synchronous.has(String(key)))
          return (...args: unknown[]) => {
            if (!policy.isActive())
              throw new BrowserPolicyError("Browser permission was revoked.");
            return value.apply(target, args);
          };
        return async (...args: unknown[]) => {
          await policy.assertActive();
          if (key === "goto") policy.assertNavigation(args[0] as string);
          if (key !== "goto" && !policy.allowsRequest(target.url()))
            throw new BrowserPolicyError();
          const result = await value.apply(target, args);
          await policy.assertActive();
          if ((key === "cdp" || key === "webmcp") && result) {
            return new Proxy(result, {
              get(rpc, method) {
                const member = Reflect.get(rpc, method);
                if (typeof member !== "function") return member;
                if (!["send", "invoke"].includes(String(method)))
                  return member.bind(rpc);
                return async (...params: unknown[]) => {
                  await policy.assertActive();
                  if (!policy.allowsRequest(target.url()))
                    throw new BrowserPolicyError();
                  if (method === "send" && params[0] === "Page.navigate")
                    policy.assertNavigation((params[1] as { url: string }).url);
                  const response = await member.apply(rpc, params);
                  await policy.assertActive();
                  return response;
                };
              },
            });
          }
          return result;
        };
      },
    });
    pages.set(page, wrapped);
    return wrapped;
  }
  return {
    async newPage() {
      await policy.assertActive();
      const page = await context.newPage();
      await policy.assertActive();
      return guard(page);
    },
    ...(context.onPageCreated
      ? {
          onPageCreated: (
            listener: Parameters<
              NonNullable<DriverContext["onPageCreated"]>
            >[0],
          ) =>
            context.onPageCreated!((event) =>
              listener({
                ...event,
                page: guard(event.page),
                opener: guard(event.opener),
              }),
            ),
        }
      : {}),
    isConnected: () => !closed && policy.isActive() && context.isConnected(),
    close,
  };
}
