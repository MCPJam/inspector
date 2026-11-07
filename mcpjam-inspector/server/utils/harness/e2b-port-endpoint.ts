/** Resolve a harness bridge without assuming the E2B hosted domain. */
export function resolveE2BPortEndpoint(
  sandbox: { sandboxId: string; getHost(port: number): string },
  port: number,
  protocol?: string,
): { url: string; headers?: Record<string, string> } {
  const proxy = process.env.E2B_SANDBOX_URL?.trim();
  if (!proxy) {
    const scheme = protocol === "ws" ? "wss" : (protocol ?? "https");
    return { url: `${scheme}://${sandbox.getHost(port)}` };
  }
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error("E2B_SANDBOX_URL must be an HTTP or HTTPS URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "E2B_SANDBOX_URL must be an HTTP or HTTPS URL without credentials, query or fragment.",
    );
  }
  if (protocol === "ws" || protocol === "wss") {
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  }
  return {
    url: url.toString(),
    headers: {
      "E2b-Sandbox-Id": sandbox.sandboxId,
      "E2b-Sandbox-Port": String(port),
    },
  };
}
