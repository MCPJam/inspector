import type { ProtocolVersionPin } from "@/hooks/use-conformance-run";

export function pinLabel(pin: ProtocolVersionPin): string {
  return pin === "auto" ? "Auto" : pin;
}

/**
 * Shown when the protocol pin changed after a run: the results on screen are
 * from the old pin until the user runs again.
 */
export function ConformanceStaleResults({
  resultsPin,
  versionPin,
}: {
  resultsPin: ProtocolVersionPin;
  versionPin: ProtocolVersionPin;
}) {
  return (
    <div
      role="status"
      className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed"
    >
      These results are from the previous run with protocol{" "}
      {pinLabel(resultsPin)}. Run again to check {pinLabel(versionPin)}.
    </div>
  );
}
