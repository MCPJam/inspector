import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { useTraceCostEnabled } from "@/hooks/useTraceCostEnabled";
import type { OrgModelProvider } from "@/hooks/use-org-model-config";
import { convexErrMessage, isConvexQueryUnavailable } from "@/lib/convex-error";
import type { SavedModelRate } from "./model-rate-dialog";
import type { ModelRateRow } from "./model-rate-format";
import { ModelRatesPanel, ModelRatesTable } from "./model-rates-panel";

export const ORG_MODEL_RATES_QUERY = "organizationModelRates:list";

type Org = { organizationId: string };
type Series = Org & { modelId: string; providerKey?: string };
const ref = makeFunctionReference;
const listRates = ref<"query", Org, ModelRateRow[]>(ORG_MODEL_RATES_QUERY);
const rateHistory = ref<"query", Series, ModelRateRow[]>(
  "organizationModelRates:history",
);
const setRate = ref<"mutation", Org & SavedModelRate>(
  "organizationModelRates:set",
);
const retireRate = ref<"mutation", Org & { rateId: string }>(
  "organizationModelRates:retire",
);

/** Not served by this deployment yet; the rule `ServerUrlChangeHistory` uses. */
export function isOrgModelRatesUnavailable(error: Error): boolean {
  const message = typeof error?.message === "string" ? error.message : "";
  if (!message.includes(`Q(${ORG_MODEL_RATES_QUERY})`)) return false;
  return isConvexQueryUnavailable(error) || message.includes("Server Error");
}

/** Runs a backend write, rejecting with the message the form shows. */
async function orExplain(write: Promise<unknown>, fallback: string) {
  try {
    await write;
  } catch (error) {
    throw new Error(convexErrMessage(error, fallback));
  }
}

type Props = Org & {
  isAdmin: boolean;
  providers: OrgModelProvider[] | undefined;
};

/**
 * "Model prices": what the organization pays, which estimates calls on its
 * own providers. Admins edit; members read. Behind `trace-cost`.
 */
export function OrganizationModelRates(props: Props) {
  if (!useTraceCostEnabled()) return null;
  return (
    <ErrorBoundary
      key={props.organizationId}
      name="org-model-rates"
      isExpectedError={isOrgModelRatesUnavailable}
      fallback={({ error }) =>
        error && isOrgModelRatesUnavailable(error) ? null : (
          <p role="alert" className="pt-8 text-sm text-destructive">
            Could not load your organization&apos;s model prices. Reload the
            page to try again.
          </p>
        )
      }
    >
      <div className="pt-8">
        <OrganizationModelRatesPanel {...props} />
      </div>
    </ErrorBoundary>
  );
}

function OrganizationModelRatesPanel({
  organizationId,
  isAdmin,
  providers,
}: Props) {
  const rates = useQuery(listRates, { organizationId });
  const save = useMutation(setRate);
  const retire = useMutation(retireRate);
  const options = (providers ?? []).map((provider) => ({
    key: provider.providerKey,
    name: provider.displayName || provider.providerKey,
  }));
  return (
    <ModelRatesPanel
      title="Model prices"
      description={`What your organization pays per million tokens. ${
        isAdmin
          ? "Calls on your providers are estimated at these prices instead of the public list price."
          : "Only admins can change these prices."
      }`}
      emptyText="No prices yet. Calls on your providers are estimated at the public list price where one exists."
      rates={rates}
      canEdit={isAdmin}
      requireProvider={false}
      providers={options}
      defaultAuthor="Unknown"
      onSave={(rate) =>
        orExplain(
          save({ organizationId, ...rate }),
          "Could not save the price. Check the values and try again.",
        )
      }
      onRetire={(rate) =>
        orExplain(
          retire({ organizationId, rateId: rate.rateId }),
          "Could not retire the price. Reload the page and try again.",
        )
      }
      renderHistory={(rate) => (
        <OrganizationRateHistory
          series={{
            organizationId,
            modelId: rate.modelId,
            ...(rate.providerKey ? { providerKey: rate.providerKey } : {}),
          }}
          providers={options}
        />
      )}
    />
  );
}

function OrganizationRateHistory({
  series,
  providers,
}: {
  series: Series;
  providers: ReadonlyArray<{ key: string; name: string }>;
}) {
  const revisions = useQuery(rateHistory, series);
  return revisions ? (
    <ModelRatesTable
      rates={revisions}
      providers={providers}
      defaultAuthor="Unknown"
    />
  ) : (
    <p className="text-sm text-muted-foreground">Loading history...</p>
  );
}
