/** Header observations belong to one task group, including overlapping runs. */
export class TaskRequestHeaders {
  private readonly listeners = new Set<
    (headers: Record<string, string>) => void
  >();

  readonly observe = (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ) => {
    if (!this.listeners.size) return;
    const headers: Record<string, string> = {};
    const requestHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    requestHeaders.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    if (
      headers["mcp-name"] !== undefined ||
      headers["mcp-method"] !== undefined
    )
      for (const listener of this.listeners) listener(headers);
  };

  async capture(fn: () => Promise<unknown>): Promise<{
    headers?: Record<string, string>;
    error?: unknown;
  }> {
    let headers: Record<string, string> | undefined;
    const listener = (seen: Record<string, string>) => {
      headers = seen;
    };
    this.listeners.add(listener);
    try {
      await fn();
      return headers === undefined ? {} : { headers };
    } catch (error) {
      return headers === undefined ? { error } : { headers, error };
    } finally {
      this.listeners.delete(listener);
    }
  }
}
