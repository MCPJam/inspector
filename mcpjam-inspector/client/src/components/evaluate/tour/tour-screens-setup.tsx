import {
  ChevronDown,
  Code,
  FileText,
  FileUp,
  Play,
  Server,
  Sparkles,
} from "lucide-react";
import { cn } from "@mcpjam/design-system/cn";
import { EXAMPLE_SUITE } from "./tour-example-data";
import { FakeButton, TourBreadcrumb } from "./tour-screen-chrome";

/** The create-suite form, as the cursor fills it in. */
export function TourCreateScreen({ typedName }: { typedName: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border/60 bg-muted/15 px-4 py-2.5 text-sm sm:px-6">
        <span className="text-muted-foreground">Evaluate</span>
        <span className="mx-1.5 text-muted-foreground">›</span>
        <span className="font-semibold text-foreground">New suite</span>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden bg-background">
        <div className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-8 sm:px-8">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-[-0.02em] text-foreground">
              Create a new eval suite
            </h1>
            <p className="text-sm text-muted-foreground">
              Set up the client you will be evaluating.
            </p>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              Suite name <span className="text-destructive">*</span>
            </p>
            <div
              data-tour-anchor="create-name"
              className={cn(
                "flex h-9 items-center rounded-md border bg-background px-3 text-sm text-foreground",
                typedName ? "border-ring" : "border-input",
              )}
            >
              {typedName}
              {typedName ? (
                <span className="ml-px h-4 w-px animate-pulse bg-foreground" />
              ) : null}
            </div>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              Servers <span className="text-destructive">*</span>
            </p>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm">
              <Server className="h-3.5 w-3.5" aria-hidden />
              {EXAMPLE_SUITE.server}
              <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            </span>
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              Clients and models <span className="text-destructive">*</span>
            </p>
            <p className="text-xs text-muted-foreground">
              Choose a client and the models to evaluate it with.
            </p>
            <div className="divide-y divide-border border-y border-border text-sm">
              <div className="grid grid-cols-2 px-2 py-2 text-xs text-muted-foreground">
                <span>Client</span>
                <span>Models</span>
              </div>
              <div className="grid grid-cols-2 px-2 py-2.5">
                <span className="inline-flex items-center gap-1">
                  {EXAMPLE_SUITE.client}
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </span>
                <span className="inline-flex items-center gap-1">
                  {EXAMPLE_SUITE.model}
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </span>
              </div>
              <div className="px-2 py-2.5">+ Add client</div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <FakeButton variant="outline" className="border-transparent">
              Cancel
            </FakeButton>
            <FakeButton variant="primary" anchor="create-continue">
              Continue
            </FakeButton>
          </div>
        </div>
      </div>
    </div>
  );
}

const CASE_SOURCES = [
  {
    id: "describe",
    icon: FileText,
    title: "Describe",
    body: "Tell us a behavior. Chat drafts the case",
  },
  {
    id: "generate",
    icon: Sparkles,
    title: "Generate",
    body: "From live discovery of your servers",
  },
  {
    id: "import",
    icon: FileUp,
    title: "Import",
    body: "Document → draft cases",
  },
] as const;

/** A new suite with no cases: the three ways to add the first ones. */
export function TourSetupScreen() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TourBreadcrumb
        crumbs={[{ label: "Evaluate" }, { label: EXAMPLE_SUITE.name }]}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-hidden px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-[-0.01em] text-foreground">
            {EXAMPLE_SUITE.name}
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <FakeButton>
              <Code className="h-3.5 w-3.5" aria-hidden />
              Setup SDK
            </FakeButton>
            <FakeButton>Configure suite evaluators</FakeButton>
            <FakeButton variant="primary-muted">
              <Play className="h-3.5 w-3.5" aria-hidden />
              Setup Run
            </FakeButton>
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-center rounded-xl border border-border px-6 pt-16">
          <p className="text-sm font-semibold text-foreground">No cases yet</p>
          <p className="mt-2 max-w-md text-center text-sm text-muted-foreground">
            Describe a behavior, generate from your servers' live discovery, or
            import an existing test file.
          </p>
          <div
            data-tour-anchor="setup-sources"
            className="mt-6 grid w-full max-w-3xl grid-cols-1 gap-2 rounded-xl bg-background p-1.5 sm:grid-cols-3"
          >
            {CASE_SOURCES.map((source) => (
              <div
                key={source.id}
                data-tour-anchor={`setup-${source.id}`}
                className="rounded-lg border border-border bg-card px-4 py-3"
              >
                <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <source.icon className="h-4 w-4" aria-hidden />
                  {source.title}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {source.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
