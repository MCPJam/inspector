import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { Button } from "@mcpjam/design-system/button";
import { Loader2 } from "lucide-react";
import { routePaths } from "@/lib/app-navigation";
import {
  BenchResultNotFoundError,
  fetchBenchResult,
  type BenchResult,
} from "@/lib/apis/bench-api";
import { BenchReport } from "./BenchReport";

const APP_ORIGIN = "https://app.mcpjam.com";

/**
 * One benchmark result, addressable only by its secret link.
 *
 * Unauthenticated on purpose, on the conformance result page's reasoning: a
 * shared result has to open in an incognito window, and the secret in the URL
 * is the whole credential. Everything rendered here is the public artifact the
 * backend chose to expose — this page has no session to read anything else
 * with, which is the property that makes the link safe to paste anywhere.
 *
 * A DEPRECATED or DELETED result still resolves and still renders, labelled.
 * That is deliberate: a link somebody shared should explain itself rather than
 * 404 into a mystery, and `BenchReport` is where the tombstone is drawn.
 */
export function BenchResultsPage() {
  const { secret } = useParams<{ secret: string }>();
  const [result, setResult] = useState<BenchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    // Drop the previous result FIRST. A secret change (or a request that
    // stalls) must never leave one connector's numbers on screen under
    // another's URL.
    setResult(null);
    if (!secret) return;
    let cancelled = false;
    setError(null);
    setNotFound(false);
    void fetchBenchResult(secret)
      .then((loaded) => {
        if (!cancelled) setResult(loaded);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof BenchResultNotFoundError) {
          setNotFound(true);
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [secret]);

  if (notFound) {
    return (
      <CenteredNotice
        title="No result here"
        body="That link isn't valid, or the run it pointed at no longer exists. Result links are private — check you copied the whole thing."
      />
    );
  }

  if (error) {
    return <CenteredNotice title="Couldn't load this result" body={error} />;
  }

  if (!result) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 overflow-y-auto px-6 py-10">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Benchmark result</h1>
        {result.targetLabel ? (
          <p className="truncate text-sm text-muted-foreground">
            {result.targetLabel}
          </p>
        ) : null}
        {typeof result.finishedAt === "number" ? (
          <p className="text-xs text-muted-foreground">
            Run {new Date(result.finishedAt).toLocaleString()}
          </p>
        ) : null}
      </header>

      <BenchReport result={result} />

      <div className="flex flex-wrap items-center gap-2">
        <Button asChild size="sm">
          <a href={`${APP_ORIGIN}/servers`}>Debug these failures in MCPJam</a>
        </Button>
        <Button asChild size="sm" variant="outline">
          <a href={routePaths.embedBench}>Benchmark your own connector</a>
        </Button>
      </div>
    </div>
  );
}

function CenteredNotice({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <p className="text-sm text-muted-foreground">{body}</p>
      <Button asChild size="sm" variant="outline">
        <a href={routePaths.embedBench}>Benchmark your own connector</a>
      </Button>
    </div>
  );
}
