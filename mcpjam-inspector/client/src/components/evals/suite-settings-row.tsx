import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@mcpjam/design-system/collapsible";
import { cn } from "@/lib/utils";
import {
  EVAL_SUITE_SETTINGS_MANIFEST,
  type EvalSuiteSettingKey,
} from "@/shared/eval-suite-settings-manifest";
import {
  suiteSettingsChainSectionClass,
  SuiteSettingsChainNode,
} from "./suite-settings-section-chain";

export type SuiteSettingsRowError = {
  message: string;
  focusSelector?: string;
};

export type SuiteSettingsRowProps = {
  settingKey: EvalSuiteSettingKey;
  label?: string;
  summary?: ReactNode;
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  actionLabel?: { open: string; closed: string };
  hint?: ReactNode;
  disabledReason?: string;
  accessory?: ReactNode;
  error?: SuiteSettingsRowError;
  /** When false, the section is always expanded with no Edit/Close row. */
  collapsible?: boolean;
  /** When false, omit the spine node (isolated tests). */
  chained?: boolean;
  className?: string;
  labelClassName?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "children">;

const DEFAULT_ACTION = { open: "Close", closed: "Edit" } as const;

const MANIFEST_LABEL: Record<EvalSuiteSettingKey, string> = Object.fromEntries(
  EVAL_SUITE_SETTINGS_MANIFEST.map((row) => [row.key, row.label]),
) as Record<EvalSuiteSettingKey, string>;

function firstFocusable(
  root: HTMLElement,
  selector?: string,
): HTMLElement | null {
  if (selector) {
    const named = root.querySelector<HTMLElement>(selector);
    if (named) return named;
  }
  const invalid = root.querySelector<HTMLElement>("[aria-invalid]");
  if (invalid) return invalid;
  return root.querySelector<HTMLElement>(
    'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
}

function SectionHeader({
  title,
  hint,
  accessory,
  summary,
  error,
  labelClassName,
  collapsible,
  isOpen,
  actionLabel,
  onFixError,
}: {
  title: string;
  hint?: ReactNode;
  accessory?: ReactNode;
  summary?: ReactNode;
  error?: SuiteSettingsRowError;
  labelClassName?: string;
  collapsible: boolean;
  isOpen: boolean;
  actionLabel: { open: string; closed: string };
  onFixError: () => void;
}) {
  return (
    <div className="mb-5 space-y-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3
              className={cn(
                "text-lg font-semibold tracking-tight text-foreground",
                labelClassName,
              )}
            >
              {title}
            </h3>
            {accessory}
          </div>
          {hint ? (
            <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
              {hint}
            </p>
          ) : null}
          {collapsible && !isOpen && summary ? (
            <div className="text-sm text-muted-foreground">{summary}</div>
          ) : null}
        </div>
        {collapsible ? (
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="shrink-0 pt-0.5 text-sm text-muted-foreground hover:text-foreground"
            >
              {isOpen ? actionLabel.open : actionLabel.closed}
            </button>
          </CollapsibleTrigger>
        ) : null}
      </div>
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          {error ? (
            <button
              type="button"
              data-settings-row-fix=""
              className="text-left text-[11px] text-destructive hover:underline"
              onClick={onFixError}
            >
              {error.message} · Fix
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One section of the suite-settings page.
 *
 * Suite-settings only. The general Settings tab keeps using the static
 * `components/setting/SettingsRow` and is not imported here.
 *
 * Default layout is Railway-style: a prominent title, optional description,
 * and always-visible content. Pass `collapsible` for the legacy ledger toggle.
 *
 * The editor is `forceMount`ed and `hidden` while collapsed so nested
 * `data-setting-key` nodes stay in the DOM and editor state survives.
 */
export function SuiteSettingsRow({
  settingKey,
  label,
  summary,
  children,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  actionLabel = DEFAULT_ACTION,
  hint,
  disabledReason,
  accessory,
  error,
  collapsible = false,
  chained = true,
  className,
  labelClassName,
  ...rest
}: SuiteSettingsRowProps) {
  const resolvedLabel = label ?? MANIFEST_LABEL[settingKey];
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = openProp !== undefined;
  const isOpen = collapsible
    ? isControlled
      ? openProp
      : uncontrolledOpen
    : true;
  const bodyRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef(false);
  const contentId = useId();

  const setOpen = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  useEffect(() => {
    if (!isOpen || !pendingFocus.current) return;
    pendingFocus.current = false;
    const root = bodyRef.current;
    if (!root) return;
    firstFocusable(root, error?.focusSelector)?.focus();
  }, [isOpen, error?.focusSelector]);

  const openAndFocus = useCallback(() => {
    pendingFocus.current = true;
    setOpen(true);
    if (isOpen) {
      pendingFocus.current = false;
      const root = bodyRef.current;
      if (root) firstFocusable(root, error?.focusSelector)?.focus();
    }
  }, [error?.focusSelector, isOpen, setOpen]);

  const isDisabled = disabledReason !== undefined;
  const wrap = (node: ReactNode) =>
    isDisabled ? (
      <fieldset disabled className="contents">
        {node}
      </fieldset>
    ) : (
      node
    );

  const { ["data-disabled-reason"]: _ignored, ...restAttrs } = rest as HTMLAttributes<HTMLDivElement> & {
    "data-disabled-reason"?: string;
  };
  void _ignored;

  const header = (
    <SectionHeader
      title={resolvedLabel}
      hint={hint}
      accessory={accessory}
      summary={summary}
      error={error}
      labelClassName={labelClassName}
      collapsible={collapsible}
      isOpen={isOpen}
      actionLabel={actionLabel}
      onFixError={openAndFocus}
    />
  );

  const body = (
    <div ref={bodyRef} id={contentId} className="space-y-3">
      {isDisabled ? (
        <p className="text-sm text-muted-foreground">{disabledReason}</p>
      ) : null}
      {wrap(children)}
    </div>
  );

  const sectionShell = chained
    ? suiteSettingsChainSectionClass(className)
    : cn("scroll-mt-6 border-t border-border/50 py-8 first:border-t-0 first:pt-2", className);

  const sectionChrome = chained ? (
    <SuiteSettingsChainNode />
  ) : null;

  if (!collapsible) {
    return (
      <section
        className={sectionShell}
        data-setting-key={settingKey}
        {...(isDisabled ? { "data-disabled-reason": disabledReason } : {})}
        {...restAttrs}
      >
        {sectionChrome}
        {header}
        {body}
      </section>
    );
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setOpen}
      className={sectionShell}
      data-setting-key={settingKey}
      {...(isDisabled ? { "data-disabled-reason": disabledReason } : {})}
      {...restAttrs}
    >
      {sectionChrome}
      {header}
      <CollapsibleContent
        forceMount
        hidden={!isOpen}
        className={cn(!isOpen && "hidden")}
      >
        {body}
      </CollapsibleContent>
    </Collapsible>
  );
}
