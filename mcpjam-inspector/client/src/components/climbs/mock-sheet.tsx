import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@mcpjam/design-system/alert";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mcpjam/design-system/sheet";
import type { PlatformMockServer } from "@mcpjam/sdk/platform";
import { readMockSheet, saveMockDefinition } from "@/lib/apis/climbs-api";
import { ChangeDisclosure } from "./change-disclosure";
import { CopyButton } from "./copy-button";
import { MockBadge } from "./mock-badge";
import {
  applyDrafts,
  checkDefinition,
  initialDraft,
  isStaleSave,
  realTools,
  schemaOf,
  toolNames,
  type ToolDraft,
} from "./mock-sheet-model";
import { MockToolEditor } from "./mock-tool-editor";
import { useAsyncRead } from "./use-async-read";

type Notice =
  | { kind: "saved"; version: number }
  | { kind: "unchanged" }
  | { kind: "stale" }
  | { kind: "failed"; message: string };

/** The mock's tools, each editable, and the one Save that stores them as the mock's next version. */
function ToolsEditor({
  mock,
  projectId,
  mockId,
  onSaved,
}: {
  mock: PlatformMockServer;
  projectId: string;
  mockId: string;
  onSaved: () => void;
}) {
  // Drafts belong to the version they were made on; a newer head starts them over.
  const [made, setMade] = useState<{ version: number; drafts: Record<string, ToolDraft> }>({ version: mock.headVersion, drafts: {} });
  const drafts = made.version === mock.headVersion ? made.drafts : {};
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const stored = checkDefinition(mock.definition);
  if (!stored.ok) {
    return (
      <Alert variant="destructive">
        <AlertTitle>This mock's definition could not be read</AlertTitle>
        <AlertDescription>{stored.error}</AlertDescription>
      </Alert>
    );
  }
  const definition = stored.value;
  const real = realTools(mock);
  const names = toolNames(definition, real);

  const save = async () => {
    setNotice(null);
    const edited = applyDrafts(definition, drafts, real);
    const checked = edited.ok ? checkDefinition(edited.value) : edited;
    if (!checked.ok) {
      setNotice({ kind: "failed", message: checked.error });
      return;
    }
    setSaving(true);
    try {
      const saved = await saveMockDefinition({ projectId, mockId, definition: checked.value, expectedVersion: mock.headVersion });
      if (!saved.created) {
        setNotice({ kind: "unchanged" });
        return;
      }
      setNotice({ kind: "saved", version: saved.version });
      onSaved();
    } catch (error) {
      setNotice(
        isStaleSave(error)
          ? { kind: "stale" }
          : { kind: "failed", message: error instanceof Error ? error.message : "The mock did not save. Try again." },
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <h3 className="mb-1 text-sm font-medium">Tools</h3>
      {names.length === 0 ? (
        <p className="text-sm text-muted-foreground">This mock lists no tools.</p>
      ) : (
        <Accordion type="single" collapsible>
          {names.map((name) => (
            <AccordionItem key={name} value={name}>
              <AccordionTrigger className="py-2.5 text-sm hover:no-underline">
                <span className="font-mono text-xs">{name}</span>
              </AccordionTrigger>
              <AccordionContent>
                <MockToolEditor
                  name={name}
                  draft={drafts[name] ?? initialDraft(definition, name, real[name])}
                  real={real[name]}
                  schema={schemaOf(definition, name, real[name])}
                  onChange={(draft) => setMade({ version: mock.headVersion, drafts: { ...drafts, [name]: draft } })}
                />
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      )}
      <div className="mt-3 flex flex-col gap-2">
        {notice?.kind === "failed" ? (
          <Alert variant="destructive">
            <AlertTitle>The mock did not save</AlertTitle>
            <AlertDescription>{notice.message}</AlertDescription>
          </Alert>
        ) : null}
        {notice?.kind === "stale" ? (
          <Alert variant="destructive">
            <AlertTitle>This mock changed since you opened it</AlertTitle>
            <AlertDescription>
              <p>Someone saved a newer version. Reload to see it, then make your edits again.</p>
              <Button
                size="sm"
                variant="outline"
                className="mt-2"
                onClick={() => {
                  setNotice(null);
                  onSaved();
                }}
              >
                Reload
              </Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {notice?.kind === "unchanged" ? (
          <p role="status" className="text-sm text-muted-foreground">Nothing changed: this mock already answers this way.</p>
        ) : null}
        {notice?.kind === "saved" ? (
          <p role="status" className="text-sm text-muted-foreground">Saved as version {notice.version}.</p>
        ) : null}
        <Button className="w-fit" disabled={saving || names.length === 0} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}

function Body({ projectId, mockId }: { projectId: string; mockId: string }) {
  const read = useAsyncRead(
    async (signal) => {
      const head = await readMockSheet({ projectId, mockId }, signal);
      // What the mock changes is its difference from its first version, which states nothing.
      return head.headVersion > 1 ? readMockSheet({ projectId, mockId, sinceVersion: 1 }, signal) : head;
    },
    `${projectId}:${mockId}`,
  );
  const mock = read.data;
  if (!mock) {
    return read.error ? (
      <Alert variant="destructive">
        <AlertTitle>The mock server did not load</AlertTitle>
        <AlertDescription>
          <p>{read.error instanceof Error ? read.error.message : "Try again."}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={read.reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    ) : (
      <p className="text-sm text-muted-foreground" role="status">
        Loading the mock server.
      </p>
    );
  }
  const changes = mock.changes ?? [];
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mock-address">Address</Label>
        {mock.address ? (
          <>
            <div className="flex gap-2">
              <Input id="mock-address" readOnly value={mock.address} className="font-mono text-xs" />
              <CopyButton text={mock.address} />
            </div>
            <p className="text-xs text-muted-foreground">
              Works anywhere a server does: the Playground, evals, and your own Claude Code or Cursor with your MCPJam API
              key.
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            This deployment has no public address for mock servers, so a client outside MCPJam cannot reach it.
          </p>
        )}
      </div>
      {mock.realServer.status === "unreachable" ? (
        <p className="text-xs text-muted-foreground">
          {mock.realServer.message ?? "The real server could not be read, so its current values are not shown."}
        </p>
      ) : null}
      <ToolsEditor mock={mock} projectId={projectId} mockId={mockId} onSaved={read.reload} />
      <div>
        <h3 className="mb-1 text-sm font-medium">Edits</h3>
        {changes.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No edits yet: this mock answers exactly as the real server does.
          </p>
        ) : (
          <Accordion type="single" collapsible>
            {changes.map((change) => (
              <AccordionItem key={`${change.target}:${change.name ?? "server"}`} value={`${change.target}:${change.name ?? "server"}`}>
                <AccordionTrigger className="py-2.5 text-sm hover:no-underline">
                  <span className="flex flex-1 items-center gap-2 text-left">
                    <span className="font-mono text-xs">{change.name ?? "The server"}</span>
                    <span className="text-xs font-normal text-muted-foreground">{change.summary}</span>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <ChangeDisclosure changes={[change]} />
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
    </div>
  );
}

/** A mock server: where to reach it, its tools to edit, and what it changes about the real server. */
export function MockSheet({
  projectId,
  mockId,
  name,
  open,
  onOpenChange,
}: {
  projectId: string;
  mockId: string | undefined;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-[560px] max-w-full flex-col gap-0 p-0">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            {name} <MockBadge />
          </SheetTitle>
          <SheetDescription>Changes apply wherever this mock is used. Your server isn't changed.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {open && mockId ? <Body projectId={projectId} mockId={mockId} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
