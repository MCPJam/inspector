/**
 * What Run opens: the steps before a conformance run. Step 1 picks the server
 * and the protocol revision; step 2 picks the suites and checks to run, and
 * its Run starts the run with them.
 */

import { useId, useState } from "react";
import { ChevronLeft } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { ServerWithName } from "@/hooks/use-app-state";
import type {
  ConformanceSelection,
  ProtocolVersionPin,
} from "@/hooks/use-conformance-run";
import { ProgressStepper } from "@/components/shared/progress-stepper";
import {
  ConformanceServerPicker,
  NO_SERVERS_MESSAGE,
  ProtocolVersionSelect,
  RUN_LABEL,
} from "./ConformancePageChrome";
import {
  ConformanceCheckPicker,
  checkCatalogs,
  nothingPicked,
} from "./ConformanceCheckPicker";

const STEPS = [
  { id: "target", label: "Choose server and protocol" },
  { id: "suites", label: "Select what to test" },
] as const;

export function ConformanceSetup({
  servers,
  initialServerName,
  initialVersionPin,
  initialSelection,
  defaultsFor,
  defaultsLoaded = true,
  onCancel,
  onRun,
}: {
  servers: ServerWithName[];
  /** Preselected: the server the page already picked. */
  initialServerName: string | null;
  initialVersionPin: ProtocolVersionPin;
  /** The last run's picks on `initialServerName`; absent means everything. */
  initialSelection?: ConformanceSelection;
  /** A server's saved default checks, from its Conformance Settings. */
  defaultsFor?: (serverName: string) => ConformanceSelection | undefined;
  /** False while the saved defaults are still loading: step 2 waits. */
  defaultsLoaded?: boolean;
  onCancel: () => void;
  onRun: (
    serverName: string,
    versionPin: ProtocolVersionPin,
    selection: ConformanceSelection,
  ) => void;
}) {
  // A draft until Run, so Cancel leaves the page's selection as it was.
  const [serverName, setServerName] = useState(initialServerName);
  const [versionPin, setVersionPin] = useState(initialVersionPin);
  const [step, setStep] = useState(0);
  // Step 2 starts from the picked server's checks: the last run's on the same
  // server, otherwise its saved defaults, otherwise everything.
  const startingSelection = (name: string | null): ConformanceSelection =>
    (name === initialServerName ? initialSelection : undefined) ??
    (name ? defaultsFor?.(name) : undefined) ??
    {};
  // Built on the first Continue, not here: the saved defaults may still be
  // loading when the steps open.
  const [selection, setSelection] = useState<ConformanceSelection>({});
  const [selectionFor, setSelectionFor] = useState<string | null>(null);
  const serverLabelId = useId();
  const versionLabelId = useId();
  const canContinue = Boolean(
    serverName && servers.some((server) => server.name === serverName),
  );
  // Opened while the server list was still loading: take the page's pick
  // once it arrives, unless the user already chose one.
  const [pageServerName, setPageServerName] = useState(initialServerName);
  if (initialServerName !== pageServerName) {
    setPageServerName(initialServerName);
    if (!canContinue && initialServerName) setServerName(initialServerName);
  }

  const continueToChecks = () => {
    if (serverName !== selectionFor) {
      setSelection(startingSelection(serverName));
      setSelectionFor(serverName);
    }
    setStep(1);
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-8 py-6">
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronLeft className="size-3.5" />
          Conformance
        </button>

        <ProgressStepper
          steps={STEPS}
          activeIndex={step}
          onStepSelect={setStep}
          ariaLabel="Conformance setup"
          className="mt-6"
        />

        {step === 0 ? (
          <>
            <h2 className="mt-3 text-2xl font-semibold tracking-[-0.02em]">
              Check for conformance
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed font-medium">
              Make sure your server is conformant to ensure reliability,
              interoperability, and security.
            </p>

            <div className="mt-6">
              <div className="mb-5">
                <div
                  id={serverLabelId}
                  className="mb-2 text-sm leading-none font-medium"
                >
                  Choose the server you want to test for protocol conformance
                </div>
                <ConformanceServerPicker
                  servers={servers}
                  selectedName={serverName}
                  onSelect={setServerName}
                  labelledBy={serverLabelId}
                />
                {servers.length === 0 ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {NO_SERVERS_MESSAGE}
                  </p>
                ) : null}
              </div>
              <div className="mb-5">
                <div
                  id={versionLabelId}
                  className="mb-2 text-sm leading-none font-medium"
                >
                  Select protocol version
                </div>
                <ProtocolVersionSelect
                  value={versionPin}
                  onChange={setVersionPin}
                  labelledBy={versionLabelId}
                />
              </div>
            </div>

            <div className="mt-7 flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                disabled={!canContinue || !defaultsLoaded}
                onClick={continueToChecks}
              >
                Continue
              </Button>
            </div>
          </>
        ) : (
          <>
            <h2 className="mt-3 text-2xl font-semibold tracking-[-0.02em]">
              Set what you'd like to test
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed font-medium">
              Pick the suites and checks this run covers.
            </p>

            {/* The protocol list follows the revision picked in step 1. */}
            <div className="mt-3">
              <ConformanceCheckPicker
                versionPin={versionPin}
                selection={selection}
                onChange={setSelection}
              />
            </div>

            <div className="mt-7 flex items-center justify-end gap-2">
              <Button variant="ghost" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button
                disabled={
                  !canContinue ||
                  nothingPicked(selection, checkCatalogs(versionPin))
                }
                onClick={() => {
                  if (serverName) onRun(serverName, versionPin, selection);
                }}
              >
                {RUN_LABEL}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
