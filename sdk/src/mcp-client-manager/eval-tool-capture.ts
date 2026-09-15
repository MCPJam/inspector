/** Node recorders install a resolver here; this module stays browser-safe. */
export type ToolCapture = {
  complete(result: unknown): void;
  fail(error: unknown): void;
};
export const evalToolCaptureResolvers = new WeakMap<
  object,
  (serverId: string, toolName: string, args: unknown) => ToolCapture | undefined
>();

export async function withEvalToolCapture<T>(
  manager: object,
  serverId: string,
  toolName: string,
  args: unknown,
  operation: () => Promise<T>
): Promise<T> {
  const capture = evalToolCaptureResolvers.get(manager)?.(
    serverId,
    toolName,
    args
  );
  try {
    const result = await operation();
    capture?.complete(result);
    return result;
  } catch (error) {
    capture?.fail(error);
    throw error;
  }
}
