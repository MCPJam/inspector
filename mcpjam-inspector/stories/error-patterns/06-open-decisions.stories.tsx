import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@mcpjam/design-system/button";
import { cn } from "@mcpjam/design-system/cn";
import { ErrorCard, severityStyles } from "@/components/ui/error-card";
import { SwarmProductionNotice } from "@/components/swarms/swarm-production-notice";
import { normalizedError } from "./_support/specimens";

/**
 * OPEN DECISIONS — nothing on this page is built.
 *
 * Pages 1 to 5 are guidance to follow now. This page holds the decisions the
 * team has not made yet. Each story is one decision and opens with a
 * recommendation and the reason for it.
 *
 * The coloured boxes render through the real `severityStyles` from ErrorCard,
 * so the colours are the product's, not an approximation.
 */
const meta = {
  title: "Error Patterns/Open decisions (not shipped)",
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "Nothing on this page is built. Each story is one open decision " +
          "with a recommendation.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

type Severity = "info" | "warning" | "error";

/**
 * A stand-in for the three-state inline message, built on the real severity
 * palette. Deliberately minimal: this is for judging colour and copy, not a
 * component proposal. If the pattern is adopted it should be built properly,
 * with the accessibility that `FieldError` and `ErrorCard` already carry.
 */
function InlineMessage({
  severity,
  title,
  body,
  cta,
  /**
   * `accent` is what the real ErrorCard wears and what almost all of the
   * product shows: a NEUTRAL panel (`bg-muted/40`, `border-border`,
   * `text-foreground`) with a coloured hairline on the left and a coloured
   * icon. Severity is carried by two small marks, not by the text.
   *
   * `filled` is `severityStyles().container`: a tinted fill with coloured
   * body text. Only `SwarmProductionNotice` uses it, for a standing notice
   * that is the only coloured thing on an otherwise healthy screen.
   */
  treatment = "accent",
}: {
  severity: Severity;
  title: string;
  body?: React.ReactNode;
  cta?: string;
  treatment?: "accent" | "filled";
}) {
  const styles = severityStyles(severity);
  const Icon = styles.icon;
  const isFilled = treatment === "filled";

  return (
    <div
      className={cn(
        "rounded-md border p-3 text-sm",
        isFilled
          ? styles.container
          : // Mirrors the real ErrorCard root: neutral ground, neutral border,
            // coloured left rule only.
            ["border-l-2 border-border bg-muted/40 dark:bg-muted/20", styles.accent],
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-0.5 size-4 shrink-0", styles.iconClass)} />
        <div className="min-w-0 flex-1">
          <p className={cn("font-medium", !isFilled && "text-foreground")}>
            {title}
          </p>
          {body ? (
            <div
              className={cn(
                "mt-1",
                // Matches SwarmProductionNotice, the one real user of the
                // filled treatment: the heading takes the tint colour, the
                // body is `text-foreground/80`.
                isFilled ? "text-foreground/80" : "text-muted-foreground",
              )}
            >
              {body}
            </div>
          ) : null}
          {cta ? (
            // Outline, not the terracotta primary, so the message keeps one
            // colour. `text-foreground` is explicit because outline sets no
            // text colour, so in a filled panel the label would take the tint.
            <Button size="sm" variant="outline" className="mt-3 text-foreground">
              {cta}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Option({
  label,
  note,
  children,
}: {
  label: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="rounded-full border border-border px-2 py-0.5 text-xs font-medium text-foreground">
          {label}
        </span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </div>
      {children}
    </section>
  );
}

function Stack({ children }: { children: React.ReactNode }) {
  return <div className="flex max-w-2xl flex-col gap-6">{children}</div>;
}

function Recommendation({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
      <p className="font-medium text-foreground">Recommendation: {title}</p>
      <div className="mt-1 space-y-2 text-muted-foreground">{children}</div>
    </div>
  );
}

function Today({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-border p-3 text-sm">
      <p className="font-medium text-foreground">Today</p>
      <div className="mt-1 space-y-2 text-muted-foreground">{children}</div>
    </div>
  );
}

/**
 * The first decision, because every other page quotes it.
 */
export const GuidanceInDesignMd: Story = {
  name: "Error guidance in DESIGN.md",
  render: () => (
    <Stack>
      <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
        <p className="font-medium text-foreground">How to read this page</p>
        <p className="mt-1 text-muted-foreground">
          Nothing on this page is built. Pages 1 to 5 are what to follow now.
          Each story here is one open decision, with a recommendation first.
        </p>
      </div>

      <Recommendation title="merge the Errors section for DESIGN.md as its own small PR, before more error work">
        <p>
          Every page here cites E1 to E4, and a rule nobody can link to is
          hard to hold a PR to. A small PR is quick to review and settles the
          wording once.
        </p>
      </Recommendation>

      <Today>
        <p>
          The four checks (E1 plain language, E2 precisely indicates the
          problem, E3 offers a way out, E4 consistent) exist only as a draft
          shared in Slack. DESIGN.md has no Errors section. These pages quote
          the draft.
        </p>
        <p>
          A draft pull request (MCPJam/inspector 7336) adds an Errors section
          with the four checks. It is not merged. Still to decide: the final
          wording, and who owns it.
        </p>
      </Today>
    </Stack>
  ),
};

/**
 * What blue, yellow and red mean.
 */
export const ThreeModalities: Story = {
  name: "The colour rule",
  render: () => (
    <Stack>
      <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
        <p className="font-medium text-foreground">Two things to know first</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <strong>Severity is an ErrorCard thing today.</strong> The blue,
            yellow and red palette lives inside ErrorCard, and the only other
            user is the Swarms production notice, which borrows it. Alert has
            only default and red. Toasts have their own kinds, and how those
            are coloured has not been checked.
          </li>
          <li>
            <strong>The boxes below are a stand-in, not ErrorCard.</strong>{" "}
            They copy its bordered card so the options can be compared side
            by side, including the filled treatment, which ErrorCard does not
            have. The real ErrorCard with a CTA is on the ErrorCard page
            (&ldquo;Retry is the wrong affordance&rdquo;).
          </li>
        </ul>
      </div>

      <p className="max-w-2xl text-sm text-muted-foreground">
        Recommendation: <strong>colour encodes how bad something is, not
        whether it blocks.</strong> Blocking is carried by the button and the
        placement. A routine action that happens to gate progress is blue with
        a prominent CTA, not amber.
      </p>

      <Option
        label="Blue"
        note="Informational. Nothing is wrong. Something routine is needed, or is worth knowing."
      >
        <InlineMessage
          severity="info"
          title="Sign in to Acme Internal to continue"
          body="Your access to this server expired."
          cta="Sign in"
        />
      </Option>

      <Option
        label="Yellow"
        note="Warning. Nothing has failed yet, but it will, or the result is degraded."
      >
        <InlineMessage
          severity="warning"
          title="This run will act on a production server"
          body="Agents take real actions on Acme Internal, including writing and deleting data."
        />
      </Option>

      <Option
        label="Red"
        note="Error. Something is broken, failed, or put data at risk."
      >
        <InlineMessage
          severity="error"
          title="Couldn't connect to Acme Internal"
          body="This URL didn't accept an MCP request."
          cta="Edit server"
        />
      </Option>

      <p className="max-w-2xl text-xs text-muted-foreground">
        Note for whoever builds this: `severityStyles` currently paints these
        from Tailwind&apos;s own `blue-*` and `amber-*` scales, not from the
        `--info` and `--warning` role tokens that already exist in
        `tokens.css`. That is worth reconciling before the palette is used more
        widely, since the role tokens are what track the theme.
      </p>
    </Stack>
  ),
};

/**
 * Accent vs filled.
 */
export const TreatmentComparison: Story = {
  name: "Accent or filled",
  render: () => (
    <Stack>
      <div className="rounded-md border border-border p-3 text-sm">
        <p className="font-medium text-foreground">Recommendation: accent, the neutral panel with a coloured left rule and icon</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
          <li>
            <strong>Readability.</strong> `text-foreground` on `bg-muted/40` is
            the highest-contrast pairing we have. A coloured heading on a tint
            of its own hue is lower, and amber is the worst of the three. DESIGN.md keeps a contrast table precisely because several
            pairings pass in one mode and fail in the other.
          </li>
          <li>
            <strong>Consistency.</strong> It is what the product already shows
            almost everywhere, so a new pattern in filled tint would read as a
            different kind of object.
          </li>
          <li>
            <strong>Restraint.</strong> DESIGN.md asks for a border or a tonal
            step over heavier treatment, and the ErrorCard comment records what
            happened when the fill was tried.
          </li>
        </ul>
        <p className="mt-2 text-muted-foreground">
          The cost is that severity now rests on a hairline and an icon, which
          is a quieter signal. That is the real trade, and it is worth deciding
          deliberately rather than by which story looked nicer.
        </p>
      </div>
      <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
        <p className="font-medium text-foreground">
          The system already has two treatments, and they are not interchangeable
        </p>
        <p className="mt-1 text-muted-foreground">
          `severityStyles` returns both an `accent` (a left-rule colour) and a
          `container` (a tinted fill with coloured text). The real ErrorCard
          uses `accent` on a neutral panel, so its title is `text-foreground`
          and only the hairline and icon carry colour. `SwarmProductionNotice`
          is the only thing using `container`.
        </p>
      </div>

      <Option
        label="Reference"
        note="The real SwarmProductionNotice component, unmodified. The only place the filled treatment ships."
      >
        <SwarmProductionNotice data-testid="story-swarm-production-notice" />
      </Option>

      {(["error", "warning", "info"] as const).map((severity) => (
        <div key={severity} className="grid gap-3 lg:grid-cols-2">
          <Option
            label={`${severity} — accent`}
            note="What ErrorCard actually renders."
          >
            <InlineMessage
              severity={severity}
              treatment="accent"
              title="Sign in to Acme Internal to continue"
              body="Your access to this server expired."
              cta="Sign in"
            />
          </Option>
          <Option
            label={`${severity} — filled`}
            note="severityStyles().container. Tinted fill, coloured heading, neutral body."
          >
            <InlineMessage
              severity={severity}
              treatment="filled"
              title="Sign in to Acme Internal to continue"
              body="Your access to this server expired."
              cta="Sign in"
            />
          </Option>
        </div>
      ))}

    </Stack>
  ),
};

/**
 * The architecture question, left open on purpose.
 */
export const OpenQuestion: Story = {
  name: "Which component for blue and yellow",
  render: () => (
    <Stack>
      <p className="max-w-2xl text-sm text-muted-foreground">
        The three states above could be a new inline-message component, or
        states of something we already have: ErrorCard or Alert. The
        recommendation is first, then the argument for each reading.
      </p>

      <Recommendation title="no new component. Something failed: ErrorCard. Nothing failed: Alert, with blue and yellow added">
        <p>
          This keeps the rule the Overview already states. ErrorCard can
          already be blue or yellow, because it takes its colour from the
          error&apos;s severity. Alert is already in the design system and the
          product already uses it for notices. A third component would give
          the team three near-identical boxes to choose between.
        </p>
        <p>
          Alert needs three things first: blue and yellow variants, a fix so a
          routine notice does not announce itself as urgent
          (`role=&quot;alert&quot;`), and a look that matches ErrorCard, which
          follows from the accent decision.
        </p>
        <p>
          Not checked: whether a blue ErrorCard reads as routine or still as
          an error, since it keeps its Retry and details controls.
        </p>
      </Recommendation>

      <div className="rounded-md border border-border p-3">
        <p className="text-sm font-medium text-foreground">
          Argument for a separate component
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          An informational message is not an error report. ErrorCard normalises
          a thrown error, carries `role=&quot;alert&quot;`, a details
          disclosure, a copy button and a docs link. None of that belongs on
          &ldquo;this run will use a production server&rdquo;. Minting a fake
          error to borrow a colour is exactly what `SwarmProductionNotice`
          already refuses to do, and it says so in its own source comment.
        </p>
      </div>

      <div className="rounded-md border border-border p-3">
        <p className="text-sm font-medium text-foreground">
          Argument for states of one component
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          We would then own three box components — Alert, ErrorCard and this —
          that look nearly identical. The product already shows the cost of
          that: `Alert` and `ErrorCard` overlap today, and this page exists
          partly because nobody could tell which to reach for.
        </p>
      </div>

      <div className="rounded-md border border-border p-3">
        <p className="text-sm font-medium text-foreground">
          Argument for extending Alert
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          The notices on the Alert page already have this shape: an icon, a
          title and a sentence in a bordered box. Some hold a button too
          (`PendingOrganizationDeletions.tsx` has &ldquo;Cancel
          deletion&rdquo;). Alert is missing two things the blue and yellow
          states need. It has only a default and a red variant. And it always
          sets `role=&quot;alert&quot;`, which interrupts a screen reader and
          is wrong for a routine notice. Adding blue and yellow variants to
          Alert would mean no new component.
        </p>
      </div>

      <p className="max-w-2xl text-sm text-muted-foreground">
        What is NOT in question either way: the three states, and the rule that
        colour encodes severity rather than blocking. That part can be agreed
        before the component shape is.
      </p>
    </Stack>
  ),
};

/**
 * Both boxes are the real ErrorCard, given the same error and the same CTA.
 */
export const CtaLayout: Story = {
  name: "ErrorCard with a CTA: bordered or compact",
  render: () => {
    const error = normalizedError({
      title: "Couldn't connect to Linear",
      oneLine: "Your sign-in for this server is no longer valid.",
    });
    const action = { label: "Sign in", onClick: () => undefined };
    return (
      <Stack>
        <Recommendation title="the bordered card is the default; the compact row only when a screen asks for it">
          <p>
            The bordered card shows the sentence without a click. The compact
            row hides it behind the title. The server card already asks for
            the row by name (`density=&quot;row&quot;` in
            `ServerConnectionCard.tsx`), so it would not change.
          </p>
          <p>
            Cost: two Playground panes would switch to the bordered card and
            need a look, and one test pins today&apos;s default.
          </p>
        </Recommendation>

        <Today>
          <p>
            An ErrorCard given a CTA and no `density` becomes the compact row.
            `PlaygroundEnvironmentSection.tsx` and `EnvironmentToolsPane.tsx`
            get the row this way.
          </p>
        </Today>

        <Option label="Today" note="A CTA and no density: the compact row.">
          <ErrorCard error={error} action={action} />
        </Option>
        <Option
          label="Recommended default"
          note="The same card with density set to card."
        >
          <ErrorCard error={error} action={action} density="card" />
        </Option>
      </Stack>
    );
  },
};

/**
 * Where the shared error components live.
 */
export const WhereComponentsLive: Story = {
  name: "Where the components live",
  render: () => (
    <Stack>
      <Recommendation title="move ErrorCard into the design system, once the layout and colour decisions are made">
        <p>
          ErrorCard is the default error surface, and `FieldError` and `Alert`
          are already in the design system. Moving it after the other
          decisions means it moves once. The toast wrapper and the full-page
          screens can stay in the app for now.
        </p>
        <p>
          Cost: ErrorCard imports five app modules (class names, clipboard,
          `WebApiError`, technical details, the feedback reporter). Each has
          to move with it or be passed in.
        </p>
      </Recommendation>

      <Today>
        <p>
          `FieldError` and `Alert` are in the design system. ErrorCard, the
          toast wrapper and the full-page screens are in the app, so nothing
          outside the inspector can reuse them, and this Storybook has to live
          in the app to show them.
        </p>
      </Today>
    </Stack>
  ),
};

/**
 * The toast audit.
 */
export const ToastAudit: Story = {
  name: "Auditing the toasts",
  render: () => (
    <Stack>
      <Recommendation title="read a sample of about 40 first, then fix validation toasts before anything else">
        <p>
          A sample sizes the work before anyone schedules it. Sort each call
          into one of three: fine as a toast, a validation message that
          belongs in `FieldError`, or a failure that needs the room an
          ErrorCard has.
        </p>
        <p>
          Validation toasts go first because they break the one hard rule on
          the Overview: a validation message never goes in a toast.
        </p>
      </Recommendation>

      <Today>
        <p>
          The client has 444 `toast.error` calls in 134 files, against 19 uses
          of ErrorCard in 14 files (tests excluded). Nobody has read through
          them, so how many belong elsewhere is not known.
        </p>
      </Today>
    </Stack>
  ),
};
