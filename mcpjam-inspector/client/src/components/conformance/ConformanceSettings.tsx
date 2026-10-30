/**
 * A server's Conformance Settings: the checks its runs pick by default. Each
 * change saves right away; Run's setup steps and one-click Run start from it.
 */

import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import type { ConformanceSelection } from "@/hooks/use-conformance-run";
import { toast } from "@/lib/toast";
import {
  ConformanceCheckPicker,
  checkCatalogs,
  nothingPicked,
} from "./ConformanceCheckPicker";

export function ConformanceSettings({
  serverName,
  defaults,
  onSave,
  onBack,
}: {
  serverName: string;
  /** The saved defaults; absent means every check. */
  defaults?: ConformanceSelection;
  onSave: (selection: ConformanceSelection) => Promise<void>;
  onBack: () => void;
}) {
  // Shown at once while the save goes out; the saved row catches up after.
  const [selection, setSelection] = useState<ConformanceSelection>(
    defaults ?? {},
  );
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched && defaults) setSelection(defaults);
  }, [defaults, touched]);

  const change = (next: ConformanceSelection) => {
    // Run again and the server list's Run use these as they are: with nothing
    // picked they would start a run that checks nothing.
    if (nothingPicked(next, checkCatalogs("auto"))) {
      toast.error("Keep at least one check selected.");
      return;
    }
    setTouched(true);
    setSelection(next);
    onSave(next).catch((error: unknown) => {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not save the default checks. Try again.",
      );
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/40 px-8 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronLeft className="size-3.5" />
            Back
          </button>
          <div className="h-4 w-px shrink-0 bg-border" />
          <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">
            {serverName} Conformance Settings
          </h2>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto w-full max-w-240">
          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <h3 className="mb-4 text-base font-medium tracking-tight">
              Default Checks
            </h3>
            {/* Defaults are revision-agnostic: the list is the full one. */}
            <ConformanceCheckPicker
              versionPin="auto"
              selection={selection}
              onChange={change}
              countLabel={(picked, total) => `${picked} of ${total}`}
              defaultOpen
            />
          </section>
        </div>
      </div>
    </div>
  );
}
