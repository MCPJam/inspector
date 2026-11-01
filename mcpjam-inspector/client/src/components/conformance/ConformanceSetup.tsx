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
import { toast } from "@/lib/toast";
import type {
  ConformanceConnectOutcome,
  ConformanceConnectServer,
} from "./ConformancePanel";
import {
  ConformanceConnectError,
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
  projectServerNames,
  projectServersLoading = false,
  initialServerName,
  initialVersionPin,
  initialSelection,
  defaultsFor,
  defaultsLoaded = true,
  onConnectServer,
  onEditServer,
  onCancel,
  onRun,
}: {
  servers: ServerWithName[];
  /**
   * Every server saved in the project, loaded in this session or not. The
   * picker lists them all, as User Testing's does, so one can be connected
   * from there.
   */
  projectServerNames?: readonly string[];
  /** The project's server list has not arrived yet. */
  projectServersLoading?: boolean;
  /** Preselected: the server the page already picked. */
  initialServerName: string | null;
  initialVersionPin: ProtocolVersionPin;
  /** The last run's picks on `initialServerName`; absent means everything. */
  initialSelection?: ConformanceSelection;
  /** A server's saved default checks, from its Conformance Settings. */
  defaultsFor?: (serverName: string) => ConformanceSelection | undefined;
  /** False while the saved defaults are still loading: step 2 waits. */
  defaultsLoaded?: boolean;
  /** Connects a server from the picker; the steps go on once it is. */
  onConnectServer?: ConformanceConnectServer;
  /** Opens a server's connection settings, offered when a connect fails. */
  onEditServer?: (serverName: string) => void;
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
  const picked = servers.find((server) => server.name === serverName);
  // Picked from the project's list before this session loaded it: it has no
  // runtime entry until it connects.
  const pickedName =
    serverName && (picked || projectServerNames?.includes(serverName))
      ? serverName
      : null;
  // Connects started here and not settled. The runtime status does not say
  // `connecting` until the provider does, and a server not loaded yet has no
  // status at all.
  const [connecting, setConnecting] = useState<readonly string[]>([]);
  // The run needs the server live, so the steps wait until it is: the picker
  // connects it in place.
  const canContinue = picked?.connectionStatus === "connected";
  // A server that is not connected can be picked, but the steps wait for it:
  // say so once, when it is picked, rather than under the field.
  const selectServer = (name: string) => {
    setServerName(name);
    const status = servers.find(
      (server) => server.name === name,
    )?.connectionStatus;
    const underway =
      connecting.includes(name) ||
      status === "connected" ||
      status === "connecting" ||
      status === "oauth-flow";
    if (!underway) toast.error(`Connect ${name} to continue.`);
  };
  // Opened while the server list was still loading: take the page's pick
  // once it arrives, unless the user already chose one.
  const [pageServerName, setPageServerName] = useState(initialServerName);
  if (initialServerName !== pageServerName) {
    setPageServerName(initialServerName);
    if (!picked && initialServerName) setServerName(initialServerName);
  }
  // The last Connect that did not end connected, kept per server so the
  // alert names the one it failed on.
  const [connectFailure, setConnectFailure] = useState<{
    serverName: string;
    needsSignIn: boolean;
  } | null>(null);
  const connect = async (name: string, signIn = false) => {
    if (!onConnectServer) return;
    setServerName(name);
    setConnectFailure(null);
    setConnecting((names) => (names.includes(name) ? names : [...names, name]));
    let outcome: ConformanceConnectOutcome;
    try {
      outcome = await onConnectServer(name, { signIn });
    } catch {
      outcome = "failed";
    }
    setConnecting((names) => names.filter((other) => other !== name));
    if (outcome !== "ready") {
      setConnectFailure({
        serverName: name,
        needsSignIn: outcome === "reauth",
      });
    }
  };
  // Connected some other way (Edit connection, the server menu): the failure
  // is over, so a later drop does not bring the old alert back.
  if (canContinue && connectFailure?.serverName === pickedName) {
    setConnectFailure(null);
  }
  const failure =
    pickedName && !canContinue && connectFailure?.serverName === pickedName
      ? connectFailure
      : null;
  const noServers =
    !projectServersLoading &&
    servers.length === 0 &&
    (projectServerNames?.length ?? 0) === 0;

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
        <Button
          variant="link"
          size="sm"
          onClick={onCancel}
          className="h-auto gap-1 px-0 text-sm has-[>svg]:px-0"
        >
          <ChevronLeft className="size-3.5" />
          Conformance
        </Button>

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
                  moreServerNames={projectServerNames}
                  loading={projectServersLoading}
                  connectingNames={connecting}
                  selectedName={serverName}
                  onSelect={selectServer}
                  onConnect={
                    onConnectServer ? (name) => void connect(name) : undefined
                  }
                  labelledBy={serverLabelId}
                />
                {noServers ? (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {NO_SERVERS_MESSAGE}
                  </p>
                ) : null}
                {failure && pickedName ? (
                  <div className="mt-3">
                    <ConformanceConnectError
                      server={picked ?? { name: pickedName }}
                      needsSignIn={failure.needsSignIn}
                      onRetry={() =>
                        void connect(pickedName, failure.needsSignIn)
                      }
                      // Edit needs the server's loaded settings.
                      onEdit={
                        onEditServer && picked
                          ? () => onEditServer(picked.name)
                          : undefined
                      }
                    />
                  </div>
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
