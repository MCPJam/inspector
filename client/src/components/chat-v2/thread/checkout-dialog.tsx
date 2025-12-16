import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatMinorAmount } from "@/lib/currency";
import type { CheckoutSession } from "@/shared/acp-types";

interface CheckoutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkoutSession: CheckoutSession | null;
  checkoutCallId: number | null;
  onRespond: (payload: { result?: unknown; error?: string }) => void;
}

export function CheckoutDialog({
  open,
  onOpenChange,
  checkoutSession,
  checkoutCallId,
  onRespond,
}: CheckoutDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(newOpen) => {
        if (!newOpen && checkoutCallId != null) {
          onRespond({ error: "Checkout canceled" });
          return;
        }
        onOpenChange(newOpen);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Checkout</DialogTitle>
        </DialogHeader>
        <ScrollArea className="max-h-[60vh] pr-4">
          {!checkoutSession ? (
            <div className="text-sm text-muted-foreground">
              No checkout session provided.
            </div>
          ) : (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <div className="text-xs text-muted-foreground">Session</div>
                  <div className="font-mono text-xs break-all">
                    {checkoutSession.id}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Status</div>
                  <div>{checkoutSession.status}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Currency</div>
                  <div>{(checkoutSession.currency || "").toUpperCase()}</div>
                </div>
                <div>
                  <div className="text-xs text-muted-foreground">Provider</div>
                  <div>{checkoutSession.payment_provider?.provider ?? "—"}</div>
                </div>
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium">Line Items</div>
                {checkoutSession.line_items?.length ? (
                  <div className="space-y-2">
                    {checkoutSession.line_items.map((item) => (
                      <div
                        key={item.id}
                        className="rounded-md border border-border/50 p-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="font-medium truncate">
                              {item.title}
                            </div>
                            {item.subtitle && (
                              <div className="text-xs text-muted-foreground truncate">
                                {item.subtitle}
                              </div>
                            )}
                            <div className="text-xs text-muted-foreground">
                              Qty: {item.quantity}
                            </div>
                          </div>
                          <div className="text-right tabular-nums">
                            <div className="font-medium">
                              {formatMinorAmount(
                                item.total ?? item.subtotal ?? 0,
                                checkoutSession.currency,
                              )}
                            </div>
                            {typeof item.tax === "number" && item.tax > 0 && (
                              <div className="text-xs text-muted-foreground">
                                Tax:{" "}
                                {formatMinorAmount(
                                  item.tax,
                                  checkoutSession.currency,
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    No line items.
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="text-xs font-medium">Totals</div>
                {checkoutSession.totals?.length ? (
                  <div className="rounded-md border border-border/50">
                    {checkoutSession.totals.map((t, idx) => (
                      <div
                        key={`${t.type}-${idx}`}
                        className="flex items-center justify-between gap-2 px-3 py-2 border-b last:border-b-0 border-border/50"
                      >
                        <div className="text-muted-foreground">
                          {t.display_text || t.type}
                        </div>
                        <div className="tabular-nums">
                          {formatMinorAmount(
                            t.amount,
                            checkoutSession.currency,
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">
                    No totals.
                  </div>
                )}
              </div>

              {!!checkoutSession.links?.length && (
                <div className="space-y-1">
                  <div className="text-xs font-medium">Links</div>
                  <div className="space-y-1">
                    {checkoutSession.links.map((l, idx) => (
                      <div key={`${l.type}-${idx}`} className="text-xs">
                        <span className="text-muted-foreground">
                          {l.text || l.type}:
                        </span>{" "}
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-2"
                        >
                          {l.url}
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {!!checkoutSession.messages?.length && (
                <div className="space-y-1">
                  <div className="text-xs font-medium">Messages</div>
                  <div className="space-y-1">
                    {checkoutSession.messages.map((m, idx) => (
                      <div key={`${m.type}-${idx}`} className="text-xs">
                        <span className="text-muted-foreground">{m.type}:</span>{" "}
                        {m.text}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            onClick={() => onRespond({ error: "Simulated checkout failure" })}
            disabled={checkoutSession == null || checkoutCallId == null}
          >
            Simulate Failure
          </Button>
          <Button
            onClick={() => {
              if (!checkoutSession) return;
              onRespond({
                result: {
                  checkout_session: {
                    ...checkoutSession,
                    status: "completed",
                    messages: checkoutSession.messages ?? [],
                  },
                  order: {
                    id: `order_${Date.now()}`,
                    checkout_session_id: checkoutSession.id,
                    permalink_url: "",
                  },
                },
              });
            }}
            disabled={checkoutSession == null || checkoutCallId == null}
          >
            Simulate Success
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
