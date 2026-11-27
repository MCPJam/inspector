import type { HostThemeMode } from "@/lib/client-styles";
import type { groupHostConfigFields, HostComparisonSubject } from "@/lib/host-config-field-schema";
import { getScenarioHostLogo } from "@/lib/scenario-client-style";
import {
  CompactClientName,
  CompactVerifiedDate,
  type CompactMatrixCell,
  type MatrixSummaryColumn,
} from "./compact-matrix-rows";

interface StackedMatrixResultsProps {
  groups: ReturnType<typeof groupHostConfigFields>;
  visibleFieldIds: ReadonlySet<string>;
  subjects: readonly HostComparisonSubject[];
  summaryColumn: MatrixSummaryColumn;
  showDescriptions: boolean;
  themeMode: HostThemeMode;
  renderCell: CompactMatrixCell;
  verifyHref: (hostId: string) => string | null;
}

export function StackedMatrixResults({
  groups,
  visibleFieldIds,
  subjects,
  summaryColumn,
  showDescriptions,
  themeMode,
  renderCell: Cell,
  verifyHref,
}: StackedMatrixResultsProps) {
  const clients = subjects.map((subject) => ({
    subject,
    href: verifyHref(subject.hostId),
    logo: getScenarioHostLogo(subject.hostStyle, subject.config.chatUiOverride, themeMode),
  }));

  return (
    <div data-caniuse-matrix="" data-testid="compare-matrix" className="min-w-0">
      {groups.flatMap(({ section, subsections }) =>
        subsections.map(({ label, fields }) => {
          const visibleFields = fields.filter(({ id }) => visibleFieldIds.has(id));
          if (!visibleFields.length) return null;

          return (
            <section key={`${section.id}-${label}`}>
              <h3 className="border-y border-border bg-muted px-3 py-2 text-xs font-semibold text-muted-foreground">
                {section.label === label ? label : `${section.label} / ${label}`}
              </h3>
              {visibleFields.map((field) => {
                const adoption = summaryColumn.render(field);
                const slices = summaryColumn.renderSlices?.(field);

                return (
                  <article key={field.id} aria-label={field.label} className="border-b border-border last:border-b-0">
                    <div className="flex items-start justify-between gap-3 px-3 py-3">
                      <div className="min-w-0">
                        <h4 className="text-base font-semibold [overflow-wrap:anywhere]">
                          {summaryColumn.renderFieldLabel?.(field) ?? field.label}
                        </h4>
                        {showDescriptions && field.description && (
                          <p className="mt-1 text-xs leading-snug text-muted-foreground">
                            {field.description}
                          </p>
                        )}
                      </div>
                      {adoption && (
                        <div className="max-w-[45%] shrink-0 tabular-nums">
                          <div className="text-[10px] text-muted-foreground">{summaryColumn.label}</div>
                          {adoption}
                        </div>
                      )}
                    </div>
                    <ul>
                      {clients.map(({ subject, href, logo }) => (
                        <li
                          key={subject.hostId}
                          className="grid grid-cols-[minmax(0,1fr)_40%] items-center gap-3 border-t border-border px-3 py-2.5"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <img src={logo} alt="" className="size-5 shrink-0 object-contain" />
                            <div className="min-w-0 [overflow-wrap:anywhere]">
                              <CompactClientName subject={subject} href={href} className="block text-sm font-semibold leading-tight" />
                              <CompactVerifiedDate subject={subject} className="mt-0.5 max-w-full text-xs" />
                            </div>
                          </div>
                          <div className="min-w-0 text-left leading-tight [overflow-wrap:anywhere] [&>*]:max-w-full [&>.inline-flex]:justify-start [&_[data-support-level]]:text-xs [&_[data-support-level]]:whitespace-normal">
                            <Cell field={field} subject={subject} mobileOptimized compact stacked />
                          </div>
                        </li>
                      ))}
                    </ul>
                    {slices && (
                      <div role="group" aria-label="Adoption by mode" className="grid grid-cols-3 gap-x-1.5 gap-y-2 border-t border-border px-3 py-2.5 tabular-nums">
                        {slices}
                      </div>
                    )}
                  </article>
                );
              })}
            </section>
          );
        }),
      )}
    </div>
  );
}
