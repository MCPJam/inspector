import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@mcpjam/design-system/button";
import { BeforeAfter, Panel } from "./_support/layout";

/**
 * PATTERN 1 — Full-page error.
 *
 * The surface for "the view cannot render at all". The client has dedicated
 * screens for this: `RouteErrorScreen`, `SessionBootstrapError`,
 * `NetworkAccessError`, `IframeRouterError`.
 *
 * NOTHING ON THIS PAGE IS A REAL COMPONENT. Both stories are drawn by hand to
 * show the shape. The real `RouteErrorScreen` needs a router around it and is
 * not rendered here. The second story's "after" copy is taken from its source;
 * everything else was written for this page.
 *
 * Two things make this pattern different from the other three. The reader has
 * lost their context entirely, so the screen has to re-establish where they
 * are. And it is the one surface where what you DON'T say can matter more than
 * what you do — see the access example below.
 */
const meta = {
  title: "Error Patterns/1. Full-page error",
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "When a view cannot render, the reader is left with nothing — no " +
          "controls, no context, no way back. The screen has to supply all " +
          "three. Never a stack trace: it is raw text (E1), it names internals " +
          "the reader did not type, and it offers nothing to do.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const ViewCannotRender: Story = {
  name: "A route throws",
  render: () => (
    <BeforeAfter>
      <Panel
        kind="before"
        caption="The default React boundary output, shipped as-is."
        provenance="illustrative"
broken={[
          "E1 — A stack trace is the purest form of raw text. It names bundled module paths the reader has never seen.",
          "E2 — Names a null dereference, not a thing the reader was trying to do.",
          "E3 — No route back. The reader's only option is the browser's back button, which often re-throws.",
        ]}
      >
        <div className="flex flex-col gap-3 py-6">
          <p className="font-mono text-sm text-destructive">
            TypeError: Cannot read properties of null (reading &apos;id&apos;)
          </p>
          <pre className="overflow-x-auto rounded bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            {"at Qe (index-4f2a1c.js:1:88421)\n" +
              "at ol (vendor-9ab3.js:9:14022)\n" +
              "at Object.he [as useMemo] (vendor-9ab3.js:9:21877)"}
          </pre>
        </div>
      </Panel>

      <Panel
        kind="after"
        caption="Re-establishes where the reader is, and gives them two ways out."
        broken={[
          "E1 — Plain sentences. The trace moved behind a disclosure, which is also where the support reference lives.",
          "E2 — Names what could not be shown.",
          "E3 — A reload and a route back to somewhere that definitely renders.",
          "Recovery — a copyable reference, so a support ticket starts with the diagnosis rather than a screenshot.",
        ]}
      >
        <div className="flex flex-col items-start gap-3 py-6">
          <p className="text-base font-medium text-foreground">
            Couldn&apos;t open this evaluation
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">
            Something went wrong while loading the page. Your evaluation and its
            results are safe — this is a display problem, not a data one.
          </p>
          <div className="flex gap-2 pt-1">
            <Button size="sm">Reload</Button>
            <Button size="sm" variant="outline">
              Back to evaluations
            </Button>
          </div>
          <p className="pt-2 font-mono text-xs text-muted-foreground">
            Reference: 01JQ8M4K2N7P
          </p>
        </div>
      </Panel>
    </BeforeAfter>
  ),
};

/**
 * The case where vagueness is a feature, not a failure of E2.
 *
 * `RouteErrorScreen` is deliberately ambiguous between "does not exist" and
 * "exists but is not yours". The backend gives one opaque answer for both so a
 * probe cannot enumerate session ids, and copy that said "this swarm belongs
 * to another project" would hand back the existence oracle the backend just
 * closed. Worth knowing because it is the one place the E2 instinct — name the
 * thing precisely — is the wrong instinct.
 */
export const DeliberateAmbiguity: Story = {
  name: "When naming the thing would leak it",
  render: () => (
    <BeforeAfter>
      <Panel
        kind="before"
        caption="Maximally precise, and a security problem."
        provenance="illustrative"
broken={[
          "Leaks existence — confirms the id resolved to a real object, and whose it is. Someone can now enumerate valid session ids by watching which message they get.",
          "Also wrong advice: a signed-out member of that project does not need an invite, they need to sign in.",
        ]}
      >
        <div className="flex flex-col items-start gap-3 py-6">
          <p className="text-base font-medium text-foreground">
            Swarm &ldquo;prod-eval-7&rdquo; belongs to the Acme Platform project
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">
            Ask an admin of Acme Platform to invite you.
          </p>
        </div>
      </Panel>

      <Panel
        kind="after"
        caption="One opaque answer for both cases, and advice that fits the reader."
        broken={[
          "The disjunction is the point, not vagueness for its own sake — it closes the enumeration oracle.",
          "No resource noun: this is the ROOT error element and it catches sessions, personas and swarms alike. Naming the thing would confirm the id resolved.",
          "E3 — still offers a way out, and branches on whether the reader is signed in.",
        ]}
      >
        <div className="flex flex-col items-start gap-3 py-6">
          <p className="text-base font-medium text-foreground">
            You don&apos;t have access to this
          </p>
          <p className="max-w-prose text-sm text-muted-foreground">
            It belongs to a project you&apos;re not a member of, or it no longer
            exists. If someone shared this link with you, ask them to invite you
            to the project.
          </p>
          <div className="flex gap-2 pt-1">
            <Button size="sm">Sign in</Button>
            <Button size="sm" variant="outline">
              Go home
            </Button>
          </div>
        </div>
      </Panel>
    </BeforeAfter>
  ),
};
