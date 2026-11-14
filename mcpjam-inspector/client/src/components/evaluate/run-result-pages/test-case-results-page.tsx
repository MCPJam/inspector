import { Button } from "@mcpjam/design-system/button";
import { CaseIterations } from "./case-iterations";
import { ResultPageTitle } from "./result-page-parts";
import {
  FROM_GRID_STATE,
  followLink,
  openResult,
  resultHref,
  targetParam,
  type MatrixTarget,
  type RunRef,
} from "./result-page-links";

export function TestCaseResultsPage({
  run,
  caseKey,
  title,
  target,
  targets,
  onEditCase,
}: {
  /** The run the link is under; sibling-run columns resolve through it. */
  run: RunRef;
  caseKey: string;
  title: string;
  target: MatrixTarget;
  targets: readonly MatrixTarget[];
  onEditCase?: () => void;
}) {
  const columnPage = (column: MatrixTarget) => ({
    caseKey,
    target: targetParam(column),
  });
  const iterationPage = (iterationId: string) => ({ caseKey, iterationId });
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto"
      data-testid="test-case-results-page"
    >
      <ResultPageTitle
        title={title}
        actions={
          onEditCase ? (
            <Button onClick={onEditCase}>Edit test case</Button>
          ) : null
        }
      />
      <div className="px-6 pb-8">
        <div
          className="mb-2 flex flex-wrap items-center justify-between gap-3"
          aria-label="Viewing client and model"
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
            Test case averages
          </span>
          {targets.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {targets.map((column) => (
                <Button
                  key={column.key}
                  asChild
                  size="sm"
                  className="h-7 rounded-full px-2.5 text-xs"
                  variant={column.key === target.key ? "secondary" : "outline"}
                >
                  <a
                    href={resultHref(run, columnPage(column))}
                    aria-current={
                      column.key === target.key ? "page" : undefined
                    }
                    onClick={(event) =>
                      followLink(event, () =>
                        openResult(run, columnPage(column), { replace: true }),
                      )
                    }
                  >
                    {column.client} · {column.model}
                  </a>
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        <CaseIterations
          target={target}
          caseKey={caseKey}
          iterationHref={(iterationId) =>
            resultHref(run, iterationPage(iterationId))
          }
          onSelectIteration={(iterationId) =>
            openResult(run, iterationPage(iterationId), {
              state: FROM_GRID_STATE,
            })
          }
        />
      </div>
    </div>
  );
}
