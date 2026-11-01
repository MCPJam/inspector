import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@mcpjam/design-system/select";
import {
  AUTH_CHALLENGE_POLICY_DEFAULTS,
  type AuthChallengeAction,
  type ToolResultAuthChallengeTrigger,
  type UnauthorizedChallengeTrigger,
} from "@mcpjam/sdk/browser";
import type { HostConfigMcpProfileV1 } from "@/lib/client-config-v2";

/**
 * Mid-session sign-in ("lazy authentication") knobs: what this client does
 * when a server refuses a call until the user signs in. Two signal families,
 * each an action plus a trigger. The absent value of each is the SDK's own
 * default (`AUTH_CHALLENGE_POLICY_DEFAULTS`), which the dropdown labels
 * "(default)" and writes back as ABSENCE, like every conformance knob here.
 *
 * Read per call, not at connect time, so there is nothing to reconnect after
 * a save.
 */
export type AuthChallengeKnob =
  | "unauthorizedChallenge"
  | "unauthorizedChallengeTrigger"
  | "toolResultAuthChallenge"
  | "toolResultAuthChallengeTrigger";

const AUTH_CHALLENGE_ACTION_LABELS: Record<AuthChallengeAction, string> = {
  prompt: "Prompt to sign in",
  notify: "Notify",
  passthrough: "Pass through",
};

const UNAUTHORIZED_CHALLENGE_TRIGGER_LABELS: Record<
  UnauthorizedChallengeTrigger,
  string
> = {
  any: "Any sign-in request",
  "bearer-header": "Needs a Bearer challenge",
  "resource-metadata": "Needs a resource metadata link",
};

const TOOL_RESULT_AUTH_CHALLENGE_TRIGGER_LABELS: Record<
  ToolResultAuthChallengeTrigger,
  string
> = {
  any: "Any",
  "oauth2-scheme": "Tool supports OAuth sign-in",
  "oauth2-scheme+error-params": "OAuth sign-in and error details",
};

const UNAUTHORIZED_CHALLENGE_DESCRIPTIONS: Record<AuthChallengeAction, string> =
  {
    prompt: "Show Connect and retry after sign-in.",
    notify: "Show a sign-in message and stop the call.",
    passthrough: "Treat the response as an ordinary error.",
  };

const UNAUTHORIZED_TRIGGER_DESCRIPTIONS: Record<
  UnauthorizedChallengeTrigger,
  string
> = {
  any: "Treat every sign-in-required response as a challenge, even without an authentication header.",
  "bearer-header":
    "Require a Bearer authentication challenge in the response header.",
  "resource-metadata":
    "Require a Bearer authentication challenge with a resource metadata link.",
};

const TOOL_RESULT_CHALLENGE_DESCRIPTIONS: Record<AuthChallengeAction, string> =
  {
    prompt:
      "When a tool result asks the user to sign in, a Connect card appears. After sign-in, the call runs again.",
    notify:
      "When a tool result asks the user to sign in, the call stops and a sign-in message appears. The call does not run again.",
    passthrough:
      "A tool result that asks the user to sign in is treated as an ordinary tool error.",
  };

const TOOL_RESULT_TRIGGER_DESCRIPTIONS: Record<
  ToolResultAuthChallengeTrigger,
  string
> = {
  any: "Every tool result carrying the challenge counts.",
  "oauth2-scheme": "Only counts when the tool supports OAuth sign-in.",
  "oauth2-scheme+error-params":
    "Only counts when the tool supports OAuth sign-in and the request includes an error code and description.",
};

/**
 * One mid-session sign-in dropdown. The SDK default is labelled "(default)"
 * and picking it writes ABSENCE, so a host that never touches the control
 * keeps hashing exactly as it did before the field existed.
 */
function AuthChallengeKnobRow<T extends string>({
  label,
  ariaLabel,
  value,
  defaultValue,
  options,
  description,
  onChange,
  readOnly,
}: {
  label: ReactNode;
  ariaLabel: string;
  value: T | undefined;
  defaultValue: T;
  options: Record<T, string>;
  description: string;
  onChange: (next: T | undefined) => void;
  readOnly: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0">
        <span className="text-[12px]">{label}</span>
        <p className="text-[11px] leading-snug text-muted-foreground">
          {description}
        </p>
      </div>
      <Select
        value={value ?? defaultValue}
        onValueChange={(next) =>
          onChange(next === defaultValue ? undefined : (next as T))
        }
        disabled={readOnly}
      >
        <SelectTrigger
          aria-label={ariaLabel}
          className="h-9 w-[220px] flex-shrink-0 text-xs"
        >
          <SelectValue placeholder={options[defaultValue]} />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(options) as T[]).map((option) => (
            <SelectItem key={option} value={option}>
              {option === defaultValue
                ? `${options[option]} (default)`
                : options[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The Protocol tab's "Mid-session sign-in" block: four dropdowns. */
export function ProtocolAuthChallengeSection({
  profile,
  onChange,
  readOnly,
}: {
  profile: HostConfigMcpProfileV1 | undefined;
  onChange: <K extends AuthChallengeKnob>(
    key: K,
    next: HostConfigMcpProfileV1[K] | undefined,
  ) => void;
  readOnly: boolean;
}) {
  // Absent reads as the SDK default for display only; a row reports the
  // default as `undefined`, so picking it writes absence back.
  const storedUnauthorizedChallenge = profile?.unauthorizedChallenge;
  const storedUnauthorizedTrigger = profile?.unauthorizedChallengeTrigger;
  const storedToolResultChallenge = profile?.toolResultAuthChallenge;
  const storedToolResultTrigger = profile?.toolResultAuthChallengeTrigger;
  const effectiveUnauthorizedChallenge =
    storedUnauthorizedChallenge ??
    AUTH_CHALLENGE_POLICY_DEFAULTS.unauthorizedChallenge;
  const effectiveToolResultChallenge =
    storedToolResultChallenge ??
    AUTH_CHALLENGE_POLICY_DEFAULTS.toolResultAuthChallenge;
  // A trigger only narrows its action, so it is inert under Pass through. Say
  // so rather than disabling the control: a stored trigger must stay editable.
  const inertTriggerNote = "No effect while the action above is Pass through.";

  return (
    <div className="mt-2.5 border-t border-border/50 pt-2.5">
      <div className="min-w-0">
        <span className="text-[12px] font-medium">Mid-session sign-in</span>
        <p className="text-[11px] leading-snug text-muted-foreground">
          Sets what this client does when a server refuses a call until the user
          signs in. Applies to the next call, with no reconnect needed.
        </p>
      </div>
      <div className="mt-2 flex flex-col divide-y divide-border/50 rounded-md border border-border/50">
        <AuthChallengeKnobRow
          label="When the server asks for sign-in"
          ariaLabel="When the server asks for sign-in"
          value={storedUnauthorizedChallenge}
          defaultValue={AUTH_CHALLENGE_POLICY_DEFAULTS.unauthorizedChallenge}
          options={AUTH_CHALLENGE_ACTION_LABELS}
          description={
            UNAUTHORIZED_CHALLENGE_DESCRIPTIONS[effectiveUnauthorizedChallenge]
          }
          onChange={(next) => onChange("unauthorizedChallenge", next)}
          readOnly={readOnly}
        />
        <AuthChallengeKnobRow
          label="What counts as a server sign-in request"
          ariaLabel="Server sign-in trigger"
          value={storedUnauthorizedTrigger}
          defaultValue={
            AUTH_CHALLENGE_POLICY_DEFAULTS.unauthorizedChallengeTrigger
          }
          options={UNAUTHORIZED_CHALLENGE_TRIGGER_LABELS}
          description={
            effectiveUnauthorizedChallenge === "passthrough"
              ? inertTriggerNote
              : UNAUTHORIZED_TRIGGER_DESCRIPTIONS[
                  storedUnauthorizedTrigger ??
                    AUTH_CHALLENGE_POLICY_DEFAULTS.unauthorizedChallengeTrigger
                ]
          }
          onChange={(next) => onChange("unauthorizedChallengeTrigger", next)}
          readOnly={readOnly}
        />
        <AuthChallengeKnobRow
          label="When a tool result asks for sign-in (ChatGPT style)"
          ariaLabel="When a tool result asks for sign-in"
          value={storedToolResultChallenge}
          defaultValue={AUTH_CHALLENGE_POLICY_DEFAULTS.toolResultAuthChallenge}
          options={AUTH_CHALLENGE_ACTION_LABELS}
          description={
            TOOL_RESULT_CHALLENGE_DESCRIPTIONS[effectiveToolResultChallenge]
          }
          onChange={(next) => onChange("toolResultAuthChallenge", next)}
          readOnly={readOnly}
        />
        <AuthChallengeKnobRow
          label="What counts as a tool result sign-in request"
          ariaLabel="Tool result sign-in trigger"
          value={storedToolResultTrigger}
          defaultValue={
            AUTH_CHALLENGE_POLICY_DEFAULTS.toolResultAuthChallengeTrigger
          }
          options={TOOL_RESULT_AUTH_CHALLENGE_TRIGGER_LABELS}
          description={
            effectiveToolResultChallenge === "passthrough"
              ? inertTriggerNote
              : TOOL_RESULT_TRIGGER_DESCRIPTIONS[
                  storedToolResultTrigger ??
                    AUTH_CHALLENGE_POLICY_DEFAULTS.toolResultAuthChallengeTrigger
                ]
          }
          onChange={(next) => onChange("toolResultAuthChallengeTrigger", next)}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}
