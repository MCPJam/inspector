import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "@mcpjam/design-system/button";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { FieldError } from "@mcpjam/design-system/field-error";
import { ErrorCard } from "@/components/ui/error-card";
import { BeforeAfter, Panel, SurfaceFrame } from "./_support/layout";
import { normalizedError, useToastSpecimen } from "./_support/specimens";

/**
 * PATTERN 4 — Toast.
 *
 * The surface for "a background failure, complete in one line". The narrowest
 * of the four and the most used: the client has 444 `toast.error` calls in 134
 * files, against 19 uses of ErrorCard in 14 files (tests excluded). How many of
 * those toasts belong on another surface has not been audited.
 *
 * Every toast here goes through the app's own wrapper at `@/lib/toast`, the
 * same one product code uses — never `sonner` directly. The wrapper is what
 * gives error toasts an eight-second duration (`ERROR_TOAST_DURATION_MS`) and a
 * hover-revealed copy button, so a toast raised here behaves exactly as it does
 * in the product. (The specimens pin `duration: Infinity` so they can be read.)
 */
const meta = {
  title: "Error Patterns/4. Toast",
  parameters: {
    layout: "padded",
    docs: {
      description: {
        component:
          "A toast is right only when the failure happened away from the " +
          "reader's attention AND the whole message fits in one line AND " +
          "nothing is lost if it goes unread. Fail any of those and it belongs " +
          "elsewhere. The usable test: an error toast stays up eight seconds, so if " +
          "acting on the message takes longer than reading it, the surface is " +
          "wrong.",
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The legitimate case for a toast, in two stories rather than two columns.
 *
 * A toast is fixed to the viewport corner and there is only ever one stack of
 * them, so two cannot be placed side by side — and for this pattern a
 * side-by-side would show nothing anyway. The component is IDENTICAL in the
 * before and the after. The only thing that changes is the words, which is the
 * whole point: when a toast is the right surface, the work is entirely in the
 * copy.
 *
 * So these two stories are the comparison. Flip between them in the sidebar and
 * read the toast each raises.
 */
export const BackgroundFailureBefore: Story = {
  name: "Background failure — vague copy (before)",
  render: function BackgroundFailureBeforeStory() {
    useToastSpecimen((toast) =>
      toast.error("Failed to save. Something went wrong.", {
        duration: Infinity,
      }),
    );

    return (
      <Panel
        kind="before"
        caption="The real toast, bottom-right. Right surface, wrong sentence — and the reader's actual question (is my work gone?) goes unanswered."
        provenance="composite"
        broken={[
          'E2 — "Something went wrong" as an entire message names nothing. This is the example NN/g calls out by name.',
          "E3 — Silence on what happens next. The reader cannot tell whether their change is lost.",
          'E4 — "Failed to" is a log verb, right in console.* and wrong in front of a reader.',
          'Composite: "Failed to save" and "Something went wrong" each appear in the client, but not together as this string.',
        ]}
      >
        <SurfaceFrame title="Autosave">
          <p className="text-sm text-muted-foreground">
            Nothing in this panel. The toast is the entire experience, which is
            what makes the copy carry all the weight.
          </p>
        </SurfaceFrame>
      </Panel>
    );
  },
};

export const BackgroundFailureAfter: Story = {
  name: "Background failure — actionable copy (after)",
  render: function BackgroundFailureAfterStory() {
    useToastSpecimen((toast) =>
      toast.error("Couldn't save your changes to Acme Internal", {
        description: "Retrying automatically. Your edits are still here.",
        duration: Infinity,
      }),
    );

    return (
      <Panel
        kind="after"
        caption="Same component, same placement, different words. Hover it for the copy button the app's wrapper adds to every error toast."
        broken={[
          "E2 — Names what failed and which thing it failed on.",
          'E3 — Says what will happen ("Retrying automatically") and confirms nothing is lost. Silence is not an option.',
          'E4 — "Couldn\'t", consistently.',
          "Placement — Correct: it happened in the background, and the whole message fits in one line.",
        ]}
      >
        <SurfaceFrame title="Autosave">
          <p className="text-sm text-muted-foreground">
            Still nothing in this panel, and still the whole experience. A toast
            earns its place only when one line genuinely settles the matter.
          </p>
        </SurfaceFrame>
      </Panel>
    );
  },
};

/**
 * The placement rule, as a story, because it is the most common mistake in the
 * codebase.
 */
export const ValidationNeverInAToast: Story = {
  name: "Validation in a toast (never do this)",
  render: function ValidationNeverInAToastStory() {
    useToastSpecimen((toast) =>
      toast.error("Please fix the errors in the form before continuing", {
        duration: Infinity,
      }),
    );

    return (
      <BeforeAfter>
        <Panel
          kind="before"
          caption="A correction the reader must act on, in a container that leaves on its own and sits nowhere near the form."
          provenance="illustrative"
broken={[
            "Placement — Hard rule: validation never goes in a toast. A dismissible toast risks the reader missing the correction entirely.",
            "E3 — It does not mark WHICH field to fix, so the way out is a hunt.",
            "Attention — the reader is looking at the form; the message is in a corner.",
          ]}
        >
          <SurfaceFrame title="Add server">
            {/* `w-fit` because SurfaceFrame is a flex column, which stretches a
                lone button to the full panel width. */}
            <Button size="sm" className="w-fit">
              Save
            </Button>
          </SurfaceFrame>
        </Panel>

        <Panel
          kind="after"
          caption="No toast. The real FieldError against the field that is actually wrong, and it names which one."
          broken={[
            "Placement — Against the control, where the reader is already looking.",
            "E2 — Names the field and what is wrong with it, rather than announcing that errors exist somewhere.",
            "E3 — Preserves what they typed; nothing is re-entered to recover.",
            'Announced — role="alert" and aria-describedby come from FieldError.',
          ]}
        >
          <SurfaceFrame title="Add server">
            <div className="flex flex-col gap-2">
              <Label htmlFor="toast-url" className="text-destructive">
                Server URL
              </Label>
              <Input
                id="toast-url"
                aria-invalid
                aria-describedby="toast-url-error"
                defaultValue="htp://example.com/mcp"
                className="border-destructive focus-visible:ring-destructive/20"
              />
              <FieldError id="toast-url-error">
                Couldn&apos;t save: the URL needs to start with http:// or
                https://.
              </FieldError>
              <div className="flex justify-end pt-1">
                <Button size="sm">Save</Button>
              </div>
            </div>
          </SurfaceFrame>
        </Panel>
      </BeforeAfter>
    );
  },
};

/**
 * The size test. When a message needs a cause, a step and a raw detail, a toast
 * physically cannot carry it — and what usually gets dropped is the cause and
 * the step, rather than the surface getting changed.
 */
export const TooMuchForTheSurface: Story = {
  name: "A message a toast cannot hold",
  render: function TooMuchForTheSurfaceStory() {
    useToastSpecimen((toast) =>
      toast.error(
        'Tool call failed: {"error":{"code":-32603,"message":"Internal error","data":{"trace":"at Server.handle (/app/dist/server.js:412:19)"}}}',
        { duration: Infinity },
      ),
    );

    return (
      <BeforeAfter>
        <Panel
          kind="before"
          caption="Everything crammed in, including the raw response body. Note it scrolls inside the toast."
          provenance="illustrative"
broken={[
            "E1 — The response body is in the message. It is unreviewed and may carry a token.",
            "Placement — Cannot be read before it leaves, which is why in practice it gets shortened to something useless instead of moved.",
          ]}
        >
          <SurfaceFrame title="Tool call">
            <p className="text-sm text-muted-foreground">
              The toast bottom-right is carrying a JSON-RPC payload.
            </p>
          </SurfaceFrame>
        </Panel>

        <Panel
          kind="after"
          caption="The line that fits stays in the toast; the diagnosis moves to an ErrorCard."
          broken={[
            "E1 — The raw payload moves to the card's collapsed detail.",
            "E3 — The toast carries one affordance that reaches the full report.",
            "Placement — The toast announces; the card explains. See the ErrorCard page.",
          ]}
        >
          <SurfaceFrame title="Tool call">
            <ErrorCard
              error={normalizedError({
                title: "Couldn't run read_file on Acme Internal",
                oneLine: "The server reported an internal error.",
                likelyCauses: [
                  "The tool threw before it returned a result.",
                ],
                nextSteps: [
                  "Check the server's own logs for the failing call.",
                ],
                rawMessage:
                  '{"error":{"code":-32603,"message":"Internal error","data":{"trace":"at Server.handle (/app/dist/server.js:412:19)"}}}',
              })}
            />
            <p className="text-xs text-muted-foreground">
              The real ErrorCard. Open <strong>Show details</strong> to see where
              the JSON-RPC payload from the before column now lives — redacted
              and copyable, out of the message.
            </p>
          </SurfaceFrame>
        </Panel>
      </BeforeAfter>
    );
  },
};
