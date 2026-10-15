import { useHarnessLiveOutput } from "@/stores/harness-live-output-store";

/**
 * The last lines a running harness command has printed (Codex streams them),
 * shown on its card until the full output arrives as the result.
 */
export function HarnessLiveOutput({
  toolCallId,
}: {
  toolCallId: string | undefined;
}) {
  const output = useHarnessLiveOutput(toolCallId);
  if (!output) return null;
  const tail = output.trimEnd().split("\n").slice(-6).join("\n");
  if (!tail) return null;
  return (
    <pre
      className="mx-3 mb-2 max-h-28 overflow-hidden whitespace-pre-wrap break-words rounded-md bg-muted/40 px-2 py-1 font-mono text-[11px] leading-4 text-muted-foreground"
      data-testid="harness-live-output"
    >
      {tail}
    </pre>
  );
}
