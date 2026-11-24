import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@mcpjam/design-system/accordion";
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
import { readMockSheet } from "@/lib/apis/climbs-api";
import { ChangeDisclosure } from "./change-disclosure";
import { CopyButton } from "./copy-button";
import { MockBadge } from "./mock-badge";
import { useAsyncRead } from "./use-async-read";

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

/** A mock server: where to reach it, and what it changes about the real one. Changes are made as rounds of a climb. */
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
          <SheetDescription>Edit it by trying changes in a climb. Your server isn't changed.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-auto px-4 pb-4">
          {open && mockId ? <Body projectId={projectId} mockId={mockId} /> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
