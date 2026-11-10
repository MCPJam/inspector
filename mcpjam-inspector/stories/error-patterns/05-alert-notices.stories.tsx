import type { Meta, StoryObj } from "@storybook/react-vite";
import { AlertCircle, AlertTriangle } from "lucide-react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@mcpjam/design-system/alert";
import { ErrorCard } from "@/components/ui/error-card";
import { BeforeAfter, Panel, SurfaceFrame } from "./_support/layout";
import { normalizedError } from "./_support/specimens";

/**
 * Alert — not one of the four error surfaces.
 *
 * `Alert` is the design system's notice box. 18 client files import it and it
 * is used 30 times (tests excluded): 14 with `variant="destructive"`, 16
 * without.
 *
 * The rule this page shows: if something failed, it is an ErrorCard, whether
 * the reader just pressed a button or a panel could not load. Alert is for a
 * notice the product writes itself, where nothing failed.
 *
 * Nothing here changes how Alert looks. In the first two stories the "after"
 * is a different component (ErrorCard), so it looks different.
 */
const meta = {
  title: "Error Patterns/Alert (not an error surface)",
  component: Alert,
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "If something failed, use ErrorCard. Use Alert for a notice the " +
          "product writes itself, where nothing failed: a trial that ended, " +
          "a step the reader still has to do.",
      },
    },
  },
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A panel that could not load is a failure, so it is an ErrorCard. Modelled on
 * the organization settings panels; the "before" wording is written for this
 * page.
 */
export const SettingsPanelDegraded: Story = {
  name: "A settings panel can't load",
  render: () => (
    <BeforeAfter>
      <Panel
        kind="before"
        caption="A red Alert that says something went wrong and nothing else."
        provenance="illustrative"
        broken={[
          "E2 — Names neither the panel nor the cause.",
          "E3 — No way out.",
          "E4 — \"Unable to\" is a second failure verb; the standard is \"Couldn't\".",
        ]}
      >
        <SurfaceFrame title="API key policy">
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>
              Unable to load organization settings.
            </AlertDescription>
          </Alert>
        </SurfaceFrame>
      </Panel>

      <Panel
        kind="after"
        caption="The same failure in the real ErrorCard."
        broken={[
          "E2 — Names the panel and says what the reader is looking at meanwhile.",
          "E3 — Retry, because trying again can work here.",
        ]}
      >
        <SurfaceFrame title="API key policy">
          <ErrorCard
            error={normalizedError({
              title: "Couldn't load this organization's API key policy",
              oneLine:
                "The values below are the last ones we loaded. Saving is turned off until the policy loads again.",
            })}
            onRetry={() => undefined}
          />
        </SurfaceFrame>
      </Panel>
    </BeforeAfter>
  ),
};

/**
 * Red Alerts that report a failed action (8 of the 14 in the client print an
 * error variable into the description) are candidates to become ErrorCards.
 * That migration is not part of this work.
 */
export const AlertVersusCard: Story = {
  name: "A save fails",
  render: () => (
    <BeforeAfter>
      <Panel
        kind="before"
        caption="A red Alert reporting a save that just failed. The title is the one OrganizationDefaultModelCard uses; the sentence under it stands in for whatever error text the save returns."
        provenance="composite"
        broken={[
          "E3 — No way out: no Retry and no way to dismiss it.",
          "There is nowhere for the technical detail to go.",
        ]}
      >
        <SurfaceFrame title="Default model">
          <Alert variant="destructive">
            <AlertTitle>Couldn&apos;t save the model</AlertTitle>
            <AlertDescription>The request was rejected.</AlertDescription>
          </Alert>
        </SurfaceFrame>
      </Panel>

      <Panel
        kind="after"
        caption="The same failure in the real ErrorCard. It can be retried and dismissed."
        broken={["E3 — Retry is on the card."]}
      >
        <SurfaceFrame title="Default model">
          <ErrorCard
            error={normalizedError({
              title: "Couldn't save the model",
              oneLine: "The request was rejected.",
            })}
            onRetry={() => undefined}
            onDismiss={() => undefined}
          />
        </SurfaceFrame>
      </Panel>
    </BeforeAfter>
  ),
};

/**
 * What Alert is for. Both are in the product today with this wording; nothing
 * failed in either, so neither is an error. The server names in the second are
 * sample values, because the product fills them in.
 */
export const WhatAlertIsFor: Story = {
  name: "What Alert is for",
  render: () => (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Two notices as they ship today (<code>App.tsx</code> and{" "}
        <code>eval-export-modal.tsx</code>). The product is telling the reader
        something. Nothing threw, so these stay as Alerts.
      </p>
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>Billing decision required</AlertTitle>
        <AlertDescription>
          This organization&apos;s trial has ended. An owner must upgrade or
          choose the free plan to restore full access.
        </AlertDescription>
      </Alert>
      <Alert className="border-border/70 bg-muted/40">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>Local server details are incomplete</AlertTitle>
        <AlertDescription>
          Replace placeholder values for linear, notion before running the
          exported file.
        </AlertDescription>
      </Alert>
    </div>
  ),
};
