import type { Page } from "@playwright/test";

interface ObservedFetch {
  url: string;
  keepalive: boolean;
  authenticated: boolean;
  policy: string | null;
}

/** Observe browser fetch options before the SDK retains its fetch reference. */
export async function observeFetchOptions(page: Page): Promise<ObservedFetch[]> {
  const requests: ObservedFetch[] = [];
  await page.exposeFunction(
    "__observeTelemetryFetch",
    (request: ObservedFetch) => {
      requests.push(request);
    },
  );
  await page.addInitScript(() => {
    const original = window.fetch;
    const observer = window as Window & {
      __observeTelemetryFetch(request: ObservedFetch): Promise<void>;
    };
    window.fetch = (input, init) => {
      const request = input instanceof Request ? input : undefined;
      const headers = new Headers(init?.headers ?? request?.headers);
      void observer.__observeTelemetryFetch({
        url: new URL(request?.url ?? String(input), window.location.href).href,
        keepalive: init?.keepalive ?? request?.keepalive ?? false,
        authenticated:
          headers.get("authorization")?.startsWith("Bearer ") ?? false,
        policy: headers.get("x-mcpjam-telemetry-policy"),
      });
      return original.call(window, input, init);
    };
  });
  return requests;
}
