/**
 * The form that records a status: "Mark as submitted" once the submission
 * went in through the portal, then each status after it. It asks how the
 * person knows, so the history can say whether it was seen first hand or
 * passed on. "Changes requested" also imports the directory's words, as
 * written, as a record of their own.
 */
import { useId, useState, type FormEvent } from "react";
import { Button } from "@mcpjam/design-system/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@mcpjam/design-system/dialog";
import { Input } from "@mcpjam/design-system/input";
import { Label } from "@mcpjam/design-system/label";
import { RadioGroup, RadioGroupItem } from "@mcpjam/design-system/radio-group";
import { Textarea } from "@mcpjam/design-system/textarea";
import type { SubmissionEventBody } from "@/lib/apis/directory-submissions-api";
import { sentenceOf } from "./error-sentence";
import { STATUS_LABELS } from "./SubmissionStatus";

/** Every status, "Submitted" included for a resubmission. */
const STATES = Object.keys(STATUS_LABELS);
const VIAS = [
  ["email", "Email"],
  ["portal", "The portal"],
  ["other", "Another way"],
] as const;

type Via = (typeof VIAS)[number][0];
type Text = Record<"reference" | "link" | "label" | "detail" | "said", string>;

const newKey = () => `ui-status-${crypto.randomUUID()}`;
/** Blank reads as absent. Text a directory wrote is sent as it is. */
const given = (value: string) => (value.trim() ? value : undefined);

function Choice<T extends string>(props: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-2">
      <p id={id} className="text-sm font-medium">
        {props.label}
      </p>
      <RadioGroup
        aria-labelledby={id}
        value={props.value}
        onValueChange={(next) => {
          const option = props.options.find(([value]) => value === next);
          if (option) props.onChange(option[0]);
        }}
        className="gap-2"
      >
        {props.options.map(([value, text]) => (
          <label key={value} className="flex items-center gap-2 text-sm">
            <RadioGroupItem value={value} />
            {text}
          </label>
        ))}
      </RadioGroup>
    </div>
  );
}

function TextField(props: {
  label: string;
  help?: string;
  value: string;
  long?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{props.label}</Label>
      {props.long ? (
        <Textarea
          id={id}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
      ) : (
        <Input
          id={id}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
        />
      )}
      {props.help ? (
        <p className="text-xs text-muted-foreground">{props.help}</p>
      ) : null}
    </div>
  );
}

export function RecordStatusDialog({
  directory,
  first,
  onRecord,
  onClose,
}: {
  directory: string;
  /** "Mark as submitted": the first status, with the receipt's details. */
  first: boolean;
  onRecord: (bodies: SubmissionEventBody[]) => Promise<void>;
  onClose: () => void;
}) {
  const [state, setState] = useState(first ? "submitted" : "in-review");
  const [source, setSource] = useState<"observed" | "reported">("observed");
  const [via, setVia] = useState<Via>("email");
  const [text, setText] = useState<Text>({
    reference: "",
    link: "",
    label: "",
    detail: "",
    said: "",
  });
  // An unchanged form retries under the same key, which the server answers
  // from the first write; a changed form is a new write.
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const changes = state === "changes-requested";
  // Submitting, first or again, comes with the portal's receipt.
  const receipt = state === "submitted";
  const edited =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setKey(newKey());
    };
  const field = (name: keyof Text) =>
    edited((value: string) =>
      setText((current) => ({ ...current, [name]: value })),
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const status: SubmissionEventBody = {
      kind: "status",
      state,
      reportedOrObserved: source,
      link: given(text.link.trim()),
      reference: receipt ? given(text.reference.trim()) : undefined,
      directoryLabel: receipt ? undefined : given(text.label),
      detail: changes ? undefined : given(text.detail),
      idempotencyKey: `${key}-status`,
    };
    const said: SubmissionEventBody = {
      kind: "directory-finding",
      reportedOrObserved: source,
      finding: { text: text.said, via },
      idempotencyKey: `${key}-finding`,
    };
    setBusy(true);
    setError(null);
    try {
      await onRecord(changes ? [said, status] : [status]);
      onClose();
    } catch (failure) {
      setError(
        `The status was not recorded. ${sentenceOf(failure)} Try recording it again.`,
      );
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>
              {first ? "Mark as submitted" : "Record a new status"}
            </DialogTitle>
            <DialogDescription>
              {first
                ? `Record it once you have submitted in the ${directory} portal. MCPJam does not submit for you.`
                : `Record what happened in the ${directory} portal. MCPJam never changes a status by itself.`}
            </DialogDescription>
          </DialogHeader>
          {first ? null : (
            <Choice
              label="Status"
              value={state}
              options={STATES.map((value) => [value, STATUS_LABELS[value]])}
              onChange={edited(setState)}
            />
          )}
          <Choice
            label="How do you know?"
            value={source}
            options={[
              ["observed", `I saw it in the ${directory} portal`],
              ["reported", `${directory} or someone else told me`],
            ]}
            onChange={edited(setSource)}
          />
          {receipt ? (
            <TextField
              label="Confirmation reference"
              help={`The reference ${directory} gave, if any.`}
              value={text.reference}
              onChange={field("reference")}
            />
          ) : (
            <TextField
              label={`${directory}'s words for it`}
              help="As the portal or the email shows the status, such as Under review."
              value={text.label}
              onChange={field("label")}
            />
          )}
          <TextField
            label={receipt ? "Management link" : "Link"}
            help={
              receipt
                ? "The submission's page in the portal."
                : "Where you saw it, such as the email or the portal page."
            }
            value={text.link}
            onChange={field("link")}
          />
          {changes ? (
            <>
              <TextField
                long
                label={`What ${directory} said`}
                help="Paste it as written. MCPJam keeps it apart from its own results."
                value={text.said}
                onChange={field("said")}
              />
              <Choice
                label="How it reached you"
                value={via}
                options={VIAS}
                onChange={edited(setVia)}
              />
            </>
          ) : (
            <TextField
              long
              label="Note"
              value={text.detail}
              onChange={field("detail")}
            />
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={busy || (changes && !given(text.said))}
            >
              {first ? "Mark as submitted" : "Record status"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
