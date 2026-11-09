import { bearerHeader, getConvexHttpUrl } from "./harness-broker-http.js";

/** Login material is written backend-to-box; this client carries only its operation id. */
export function cursorRuntimeLogin(args: {
  sandboxRowId: string;
  runId: string;
  modelId: string;
  authorization: () => Promise<string>;
  signal?: AbortSignal;
}) {
  const installId = crypto.randomUUID();
  let started = false;
  const request = async (
    operation: "install" | "clear",
    signal: AbortSignal,
  ) => {
    const response = await fetch(
      `${getConvexHttpUrl()}/web/harness/runtime-login/${operation}`,
      {
        method: "POST",
        headers: {
          authorization: bearerHeader(await args.authorization()),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sandboxRowId: args.sandboxRowId,
          runId: args.runId,
          harnessId: "cursor",
          modelId: args.modelId,
          installId,
        }),
        signal,
      },
    );
    const body: unknown = await response.json();
    if (
      !response.ok ||
      !body ||
      typeof body !== "object" ||
      !("ok" in body) ||
      body.ok !== true
    )
      throw new Error(
        operation === "install"
          ? "Could not prepare the Cursor login. Check the organization key and retry."
          : "Cursor login cleanup could not be confirmed. Start with a new sandbox.",
      );
    return body;
  };
  return {
    async install() {
      started = true;
      const timeout = AbortSignal.timeout(60_000);
      await request(
        "install",
        args.signal ? AbortSignal.any([args.signal, timeout]) : timeout,
      );
    },
    async clear() {
      if (started) await request("clear", AbortSignal.timeout(60_000));
    },
  };
}
