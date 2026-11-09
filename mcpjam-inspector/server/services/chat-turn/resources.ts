/** Resources acquired for one turn, never borrowed debugger or durable state. */
export class TurnResources {
  private releases: Array<() => void | Promise<void>> = [];
  private disposal?: Promise<void>;

  constructor(private readonly reportFailure: (error: unknown) => void) {}

  own(release: () => void | Promise<void>): void {
    if (this.disposal)
      throw new Error("Cannot acquire resources after a turn ended");
    this.releases.push(release);
  }

  dispose(): Promise<void> {
    // Assign before invoking callbacks: cancellation and stream completion can
    // arrive together, and a callback may itself initiate cancellation.
    this.disposal ??= Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      for (const release of this.releases.reverse()) {
        try {
          await release();
        } catch (error) {
          failures.push(error);
        }
      }
      this.releases = [];
      for (const error of failures) this.reportFailure(error);
    });
    return this.disposal;
  }

  /**
   * Transfer ownership only after preparation has produced a response.
   * `headers` are added to the streamed copy, never to `response` itself.
   */
  response(
    response: Response,
    signal?: AbortSignal,
    headers?: Record<string, string>,
  ): Response {
    const onAbort = () => {
      void this.dispose();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const finish = async () => {
      signal?.removeEventListener("abort", onAbort);
      await this.dispose();
    };
    if (signal?.aborted) onAbort();
    if (!response.body) {
      void finish();
      return response;
    }
    const reader = response.body.getReader();
    const outgoing = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers ?? {})) {
      outgoing.set(name, value);
    }
    return new Response(
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              await finish();
              controller.close();
            } else {
              controller.enqueue(result.value);
            }
          } catch (error) {
            await finish();
            controller.error(error);
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            await finish();
          }
        },
      }),
      {
        status: response.status,
        statusText: response.statusText,
        headers: outgoing,
      },
    );
  }
}
