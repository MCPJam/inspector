/**
 * A server's Conformance Settings: the checks its runs pick by default, and
 * how long a run may take. Each change saves right away; Run's setup steps
 * and one-click Run start from it.
 */

import { useEffect, useRef, useState } from "react";
import { stableStringifyJson } from "@mcpjam/sdk/widget-runtime";
import { DetailPageHeader } from "@/components/shared/detail-page-header";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ConformanceProbes } from "@/hooks/use-conformance-probes";
import type { ConformanceConnectServer } from "./ConformancePanel";
import { ConformanceChecksEditor } from "./ConformanceChecksEditor";
import { ConformanceSettingsConnection } from "./ConformanceSettingsConnection";
import { ConformanceTimeoutSetting } from "./ConformanceTimeout";
import type { ConformanceSelection } from "@/hooks/use-conformance-run";
import { toast } from "@/lib/toast";
import {
  checkCatalogs,
  nothingPicked,
} from "./ConformanceCheckPicker";

export function ConformanceSettings({
  serverName,
  server,
  inputs,
  onConnectServer,
  onEditServer,
  defaults,
  onSave,
  timeoutSeconds,
  onSaveTimeout,
  onBack,
  backDisabled: backHeld = false,
}: {
  serverName: string;
  server?: ServerWithName;
  inputs?: ConformanceProbes;
  onConnectServer?: ConformanceConnectServer;
  onEditServer?: (name: string) => void;
  /** The saved defaults; absent means every check. */
  defaults?: ConformanceSelection;
  onSave: (
    selection: ConformanceSelection,
    inputs: ConformanceProbes,
  ) => Promise<void>;
  /** The saved run timeout override; absent means the default. */
  timeoutSeconds?: number;
  /** Saves the run timeout; null goes back to the default. No section without it. */
  onSaveTimeout?: (seconds: number | null) => Promise<void>;
  onBack: () => void;
  backDisabled?: boolean;
}) {
  // A timeout that is not valid holds Back, as an invalid input does. Its
  // save in flight does not (see `ConformanceTimeoutSetting`).
  const [timeoutInvalid, setTimeoutInvalid] = useState(false);
  const backDisabled = backHeld || timeoutInvalid;
  const storedKey = stableStringifyJson({
    selection: defaults ?? {},
    inputs: inputs ?? {},
  });
  const [draft, setDraft] = useState({
    selection: defaults ?? {},
    inputs: inputs ?? {},
  });
  const [touched, setTouched] = useState(false);
  const [inputsValid, setInputsValid] = useState(true);
  const [pending, setPending] = useState(0);
  const [editorVersion, setEditorVersion] = useState(0);
  const latestChange = useRef(0);
  const sent = useRef(storedKey);
  useEffect(() => {
    if (touched || pending || !inputsValid) return;
    if (stableStringifyJson(draft) !== storedKey)
      setEditorVersion((version) => version + 1);
    setDraft({ selection: defaults ?? {}, inputs: inputs ?? {} });
    sent.current = storedKey;
  }, [storedKey, touched, pending, inputsValid]);
  const draftKey = stableStringifyJson(draft);
  useEffect(() => {
    if (!touched || !inputsValid) return;
    if (draftKey === sent.current) {
      if (!pending) setTouched(false);
      return;
    }
    sent.current = draftKey;
    const id = ++latestChange.current;
    setPending((count) => count + 1);
    onSave(draft.selection, draft.inputs)
      .catch(() => {
        toast.error("Could not save the default checks and inputs. Try again.");
      })
      .finally(() => {
        setPending((count) => count - 1);
        if (latestChange.current === id) setTouched(false);
      });
  }, [draftKey, touched, inputsValid, onSave]);
  const change = (next: ConformanceSelection) => {
    if (nothingPicked(next, checkCatalogs("auto"))) {
      toast.error("Keep at least one check selected.");
      return;
    }
    setTouched(true);
    setDraft((prev) => ({ ...prev, selection: next }));
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* The same header as a run, which Settings opens from: its Back
          looks and moves like every other Back in Conformance. */}
      <DetailPageHeader
        backLabel="Back"
        onBack={onBack}
        backTestId="conformance-settings-back"
        backDisabled={backDisabled || pending > 0 || touched || !inputsValid}
        title={
          <h2
            className="truncate text-xl font-bold tracking-tight text-foreground"
            title={`${serverName} Conformance Settings`}
          >
            {serverName} Conformance Settings
          </h2>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
        <div className="mx-auto w-full max-w-240">
          {onSaveTimeout ? (
            <section className="mb-4 rounded-xl border border-border bg-card p-5 shadow-sm">
              <h3 className="mb-4 text-base font-medium tracking-tight">
                Run Timeout
              </h3>
              <ConformanceTimeoutSetting
                seconds={timeoutSeconds}
                onSave={onSaveTimeout}
                onInvalidChange={setTimeoutInvalid}
              />
            </section>
          ) : null}
          <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
            <h3 className="mb-4 text-base font-medium tracking-tight">
              Default Checks
            </h3>
            {/* Defaults are revision-agnostic: the list is the full one. */}
            <ConformanceSettingsConnection
              server={server}
              onConnectServer={onConnectServer}
              onEditServer={onEditServer}
            />
            <ConformanceChecksEditor
              key={editorVersion}
              server={server}
              versionPin="auto"
              selection={draft.selection}
              onChange={change}
              probes={draft.inputs}
              onProbesChange={(next) => {
                setTouched(true);
                setDraft((prev) => ({ ...prev, inputs: next }));
              }}
              onValidChange={setInputsValid}
              defaultsMode
            />
          </section>
        </div>
      </div>
    </div>
  );
}
