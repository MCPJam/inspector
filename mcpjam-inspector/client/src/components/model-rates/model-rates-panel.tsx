import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@mcpjam/design-system/alert-dialog";
import { Badge } from "@mcpjam/design-system/badge";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@mcpjam/design-system/table";
import { toast } from "@/lib/toast";
import { MODEL_RATE_FIELDS } from "@/shared/model-rate-input";
import { ModelRateDialog, type SavedModelRate } from "./model-rate-dialog";
import {
  formatDay,
  formatRate,
  listPriceLine,
  type ModelRateRow,
} from "./model-rate-format";
import { useListPrices } from "./use-list-prices";

type Provider = { key: string; name: string };

const HEADINGS =
  "Model,Provider,Input,Output,Cache read,Cache write,Effective,Updated by,Revision".split(
    ",",
  );

/**
 * For each scheduled rate, by `rateId`, the revision in force until it
 * starts, or null when none is. A rate missing here shows no such row.
 */
export type InForceRates = ReadonlyMap<string, ModelRateRow | null>;

/** Prices per million tokens; `actions` adds the controls a row offers. */
export function ModelRatesTable({
  rates,
  providers,
  defaultAuthor,
  actions,
  inForce,
}: {
  rates: ModelRateRow[];
  providers: readonly Provider[];
  defaultAuthor: string;
  actions?: (rate: ModelRateRow) => ReactNode;
  inForce?: InForceRates;
}) {
  const listPrices = useListPrices(rates.length > 0);
  const now = Date.now();
  /** The price, date, author and revision cells of one revision. */
  const revisionCells = (rate: ModelRateRow) => {
    const status =
      rate.retiredAt !== undefined
        ? "Retired"
        : rate.effectiveAt > now
          ? "Scheduled"
          : undefined;
    return (
      <>
        {MODEL_RATE_FIELDS.map((field) => (
          <TableCell key={field} className="tabular-nums">
            {formatRate(rate.rates[field])}
          </TableCell>
        ))}
        <TableCell className="whitespace-nowrap">
          {formatDay(rate.effectiveAt)}
          {status ? (
            <Badge variant="outline" className="ml-2">
              {status}
            </Badge>
          ) : null}
        </TableCell>
        <TableCell>
          {rate.createdBy?.name || rate.createdBy?.email || defaultAuthor}
        </TableCell>
        <TableCell className="tabular-nums">{rate.revision}</TableCell>
      </>
    );
  };
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {HEADINGS.map((heading) => (
              <TableHead key={heading}>{heading}</TableHead>
            ))}
            {actions ? (
              <TableHead className="sr-only">Actions</TableHead>
            ) : null}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rates.map((rate) => {
            const listPrice = listPrices.get(rate.modelId);
            const current = inForce?.get(rate.rateId);
            const until = formatDay(rate.effectiveAt);
            const provider = rate.providerKey
              ? (providers.find((p) => p.key === rate.providerKey)?.name ??
                rate.providerKey)
              : "Any provider";
            return [
              <TableRow key={rate.rateId} className="align-top">
                <TableCell>
                  <div className="font-mono text-xs text-foreground">
                    {rate.modelId}
                  </div>
                  {[listPrice && listPriceLine(listPrice), rate.note]
                    .filter(Boolean)
                    .map((line) => (
                      <div key={line} className="text-xs text-muted-foreground">
                        {line}
                      </div>
                    ))}
                </TableCell>
                <TableCell>{provider}</TableCell>
                {revisionCells(rate)}
                {actions ? (
                  <TableCell className="whitespace-nowrap text-right">
                    {actions(rate)}
                  </TableCell>
                ) : null}
              </TableRow>,
              current === undefined ? null : (
                <TableRow
                  key={`${rate.rateId}:in-force`}
                  className="align-top text-muted-foreground"
                >
                  {current ? (
                    <>
                      <TableCell className="text-xs">
                        {`In force until ${until}`}
                      </TableCell>
                      <TableCell />
                      {revisionCells(current)}
                      {actions ? <TableCell /> : null}
                    </>
                  ) : (
                    <TableCell
                      colSpan={HEADINGS.length + (actions ? 1 : 0)}
                      className="text-xs"
                    >
                      {`No price in force until ${until}.`}
                    </TableCell>
                  )}
                </TableRow>
              ),
            ];
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * Saved prices with add, edit and retire for an editor, and each rate's
 * history when the caller can load it. Without `canEdit` there are no edit
 * controls at all.
 */
export function ModelRatesPanel({
  title,
  description,
  emptyText,
  rates,
  loadError,
  canEdit,
  requireProvider,
  providers,
  defaultAuthor,
  onSave,
  onRetire,
  renderHistory,
  inForce,
}: {
  title: string;
  description: string;
  emptyText: string;
  /** Undefined while loading. */
  rates: ModelRateRow[] | undefined;
  loadError?: string;
  canEdit: boolean;
  requireProvider: boolean;
  providers: readonly Provider[];
  defaultAuthor: string;
  /** Both reject with the message to show when they fail. */
  onSave: (rate: SavedModelRate) => Promise<void>;
  onRetire: (rate: ModelRateRow) => Promise<void>;
  renderHistory?: (rate: ModelRateRow) => ReactNode;
  inForce?: InForceRates;
}) {
  const [editing, setEditing] = useState<ModelRateRow | "new">();
  const [retiring, setRetiring] = useState<ModelRateRow>();
  const [historyOf, setHistoryOf] = useState<ModelRateRow>();

  const retire = async () => {
    if (!retiring) return;
    try {
      await onRetire(retiring);
      toast.success("Price retired.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setRetiring(undefined);
    }
  };
  const action = (label: string, run: () => void) => (
    <Button key={label} size="sm" variant="ghost" onClick={run}>
      {label}
    </Button>
  );

  return (
    <section className="space-y-3" data-testid="model-rates-panel">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{title}</h2>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        {canEdit ? (
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <Plus className="mr-2 size-4" />
            Add price
          </Button>
        ) : null}
      </div>
      {loadError ? (
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      ) : !rates ? (
        <p className="text-sm text-muted-foreground">Loading prices...</p>
      ) : rates.length === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      ) : (
        <ModelRatesTable
          rates={rates}
          providers={providers}
          defaultAuthor={defaultAuthor}
          inForce={inForce}
          actions={(rate) => [
            renderHistory && action("History", () => setHistoryOf(rate)),
            canEdit && action("Edit", () => setEditing(rate)),
            canEdit && action("Retire", () => setRetiring(rate)),
          ]}
        />
      )}

      {canEdit ? (
        <ModelRateDialog
          open={editing !== undefined}
          onOpenChange={(open) => !open && setEditing(undefined)}
          editing={editing === "new" ? undefined : editing}
          providers={providers}
          requireProvider={requireProvider}
          onSave={async (rate) => {
            await onSave(rate);
            toast.success("Price saved.");
          }}
        />
      ) : null}

      <AlertDialog
        open={retiring !== undefined}
        onOpenChange={(open) => !open && setRetiring(undefined)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Retire the price for {retiring?.modelId}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              New calls stop using it. Calls already priced keep the price they
              used.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                void retire();
              }}
            >
              Retire
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={historyOf !== undefined}
        onOpenChange={(open) => !open && setHistoryOf(undefined)}
      >
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Price history for {historyOf?.modelId}</DialogTitle>
          </DialogHeader>
          {historyOf && renderHistory?.(historyOf)}
        </DialogContent>
      </Dialog>
    </section>
  );
}
