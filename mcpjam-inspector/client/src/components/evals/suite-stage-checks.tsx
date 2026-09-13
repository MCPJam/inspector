import { Checkbox } from "@mcpjam/design-system/checkbox";
import {
  SUITE_STAGE_CHECKS,
  normalizeDisabledStageChecks,
} from "./suite-stage-check-catalog";

export function SuiteStageChecks({
  disabledChecks = [],
  onChange,
  readOnly = false,
  suiteDisabledChecks,
  editableCheckIds,
}: {
  disabledChecks?: readonly string[];
  onChange: (disabled: string[] | undefined) => void;
  readOnly?: boolean;
  suiteDisabledChecks?: readonly string[];
  editableCheckIds?: readonly string[];
}) {
  return (
    <section
      data-setting-key="checks"
      aria-labelledby="suite-stage-checks-title"
    >
      <div className="mb-5 space-y-1.5">
        <h3
          id="suite-stage-checks-title"
          className="text-lg font-semibold tracking-tight text-foreground"
        >
          Assertions by stage
        </h3>
        <p className="text-sm text-muted-foreground">
          {suiteDisabledChecks
            ? "Standard assertions inherited from the suite. Changes for this case are marked below."
            : "Choose which assertions to run at each stage. All assertions are on by default."}
        </p>
      </div>
      <table className="w-full table-fixed border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-border">
            <th
              scope="col"
              className="w-[32%] py-3 pr-6 align-bottom text-xs font-medium text-muted-foreground"
            >
              Stage of user value chain
            </th>
            <th
              scope="col"
              className="py-3 text-xs font-medium text-muted-foreground"
            >
              What we check
            </th>
          </tr>
        </thead>
        <tbody>
          {SUITE_STAGE_CHECKS.map(({ stage, label, checks }) => (
            <tr
              key={stage}
              data-stage-group={stage}
              className="border-b border-border last:border-0"
            >
              <th
                scope="row"
                className="py-5 pr-6 align-top font-medium text-foreground"
              >
                {label}
              </th>
              <td className="py-5 align-top">
                <ul className="space-y-3 text-foreground">
                  {checks.map(({ id, label: checkLabel }) => {
                    const differs =
                      suiteDisabledChecks !== undefined &&
                      disabledChecks.includes(id) !==
                        suiteDisabledChecks.includes(id);
                    return (
                      <li key={id}>
                        <label className="flex cursor-pointer items-start gap-2.5 has-[:disabled]:cursor-default has-[:disabled]:opacity-60">
                          <Checkbox
                            className="mt-0.5"
                            checked={!disabledChecks.includes(id)}
                            aria-label={checkLabel}
                            disabled={
                              readOnly ||
                              (editableCheckIds !== undefined &&
                                !editableCheckIds.includes(id))
                            }
                            onCheckedChange={(checked) =>
                              onChange(
                                normalizeDisabledStageChecks(
                                  checked === true
                                    ? disabledChecks.filter(
                                        (checkId) => checkId !== id,
                                      )
                                    : [...disabledChecks, id],
                                ),
                              )
                            }
                          />
                          <span>{checkLabel}</span>
                          {differs ? (
                            <span
                              className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                              title="Overrides the suite default"
                            >
                              Override
                            </span>
                          ) : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
