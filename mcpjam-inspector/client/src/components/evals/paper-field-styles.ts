/** Shared typography for Paper authoring fields. Small numeric inputs keep their compact shape. */
export const PAPER_FIELD_STYLES =
  "[font-synthesis:none] font-sans antialiased text-sm font-normal leading-[18px] text-card-foreground " +
  "[&_.space-y-1]:space-y-1.5 [&_.space-y-2]:space-y-1.5 [&_.space-y-3]:space-y-1.5 [&_.gap-2]:gap-1.5 " +
  "[&_label:not(details_*):not([data-paper-unit])]:text-sm [&_label:not(details_*):not([data-paper-unit])]:font-medium [&_label:not(details_*):not([data-paper-unit])]:leading-[18px] [&_label]:text-card-foreground " +
  "[&_input]:font-normal [&_input]:text-card-foreground [&_textarea]:font-normal [&_textarea]:text-card-foreground " +
  "[&_button[role=combobox]]:font-normal [&_button[role=combobox]]:text-card-foreground " +
  "[&_p:not(.text-destructive)]:text-[13px] [&_p:not(.text-destructive)]:font-normal [&_p:not(.text-destructive)]:leading-[18px] [&_p:not(.text-destructive)]:text-card-foreground " +
  "[&_details]:text-xs [&_details]:font-normal [&_details]:text-card-foreground " +
  "[&_details_label]:text-xs [&_details_label]:font-normal [&_details_label]:leading-4 " +
  "[&_details_input]:text-xs [&_details_textarea]:text-xs [&_details_button[role=combobox]]:text-xs";
