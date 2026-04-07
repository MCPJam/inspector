import { cn } from "@/lib/utils";
import { JsonEditor } from "./json-editor";
import type { JsonEditorProps } from "./types";

type ScrollableJsonViewProps = Pick<
  JsonEditorProps,
  | "value"
  | "className"
  | "collapsible"
  | "defaultExpandDepth"
  | "collapsedPaths"
  | "onCollapseChange"
  | "collapseStringsAfterLength"
  | "expandJsonStrings"
  | "wrapLongLinesInView"
  | "showLineNumbers"
> & {
  containerClassName?: string;
};

export function ScrollableJsonView({
  value,
  className,
  collapsible = false,
  defaultExpandDepth,
  collapsedPaths,
  onCollapseChange,
  collapseStringsAfterLength,
  expandJsonStrings = false,
  wrapLongLinesInView = true,
  showLineNumbers = true,
  containerClassName,
}: ScrollableJsonViewProps) {
  return (
    <div className={cn("overflow-auto", containerClassName)}>
      <JsonEditor
        value={value}
        className={className}
        collapsible={collapsible}
        defaultExpandDepth={defaultExpandDepth}
        collapsedPaths={collapsedPaths}
        onCollapseChange={onCollapseChange}
        collapseStringsAfterLength={collapseStringsAfterLength}
        expandJsonStrings={expandJsonStrings}
        wrapLongLinesInView={wrapLongLinesInView}
        showLineNumbers={showLineNumbers}
        height="auto"
        viewOnly
        showToolbar={false}
      />
    </div>
  );
}
