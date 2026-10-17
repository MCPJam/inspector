import type { AppServerClient } from "./app-server-client.js";

/** Setup runs inside the supervised app-server tree, before a thread can start. */
export async function setupWindowsSandbox(
  client: Pick<AppServerClient, "request" | "onNotification">,
  cwd: string,
  timeoutMs = 120_000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = new Promise<void>((resolve, reject) => {
    client.onNotification((notice) => {
      if (notice.method !== "windowsSandbox/setupCompleted") return;
      const params = notice.params as
        | { mode?: unknown; success?: unknown; error?: unknown }
        | undefined;
      if (params?.mode !== "unelevated") return;
      if (params.success === true) resolve();
      else
        reject(
          new Error(
            typeof params.error === "string"
              ? params.error
              : "Windows sandbox setup failed",
          ),
        );
    });
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Windows sandbox setup timed out")),
      timeoutMs,
    );
  });
  try {
    await Promise.race([
      Promise.all([
        client
          .request<{ started: boolean }>("windowsSandbox/setupStart", {
            mode: "unelevated",
            cwd,
          })
          .then((result) => {
            if (result.started !== true)
              throw new Error("Windows sandbox setup did not start");
          }),
        completed,
      ]),
      deadline,
    ]);
  } finally {
    clearTimeout(timer);
    client.onNotification(() => undefined);
  }
}
