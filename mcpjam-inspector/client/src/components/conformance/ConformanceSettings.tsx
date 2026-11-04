/**
 * A server's Conformance Settings: the checks its runs pick by default. Each
 * change saves right away; Run's setup steps and one-click Run start from it.
 */

import { useEffect, useRef, useState } from "react";
import { stableStringifyJson } from "@mcpjam/sdk/widget-runtime";
import { ChevronLeft } from "lucide-react";
import { Button } from "@mcpjam/design-system/button";
import type { ServerWithName } from "@/hooks/use-app-state";
import type { ConformanceProbes } from "@/hooks/use-conformance-probes";
import type { ConformanceConnectServer } from "./ConformancePanel";
import { ConformanceChecksEditor } from "./ConformanceChecksEditor";
import { ConformanceSettingsConnection } from "./ConformanceSettingsConnection";
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
  onBack,
  backDisabled = false,
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
  onBack: () => void;
  backDisabled?: boolean;
}) {
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
      <div className="shrink-0 border-b border-border/40 px-8 py-2.5">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            variant="link"
            size="sm"
            onClick={onBack}
            disabled={backDisabled || pending > 0 || touched || !inputsValid}
            className="h-auto gap-1 px-0 text-sm has-[>svg]:px-0"
          >
            <ChevronLeft className="size-3.5" />
            Back
          </Button>
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
