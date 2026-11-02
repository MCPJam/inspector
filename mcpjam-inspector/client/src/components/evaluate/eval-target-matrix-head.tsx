import { tableHeadLabelClass } from "@mcpjam/design-system/table";

/** The client/model matrix's column labels, in the shared readable style. */
export function EvalTargetMatrixHead() {
  return (
    <thead className={tableHeadLabelClass}>
      <tr className="border-b border-border">
        <th scope="col" className="w-[40%] px-2 py-2">
          Client
        </th>
        <th scope="col" className="px-2 py-2">
          Models
        </th>
      </tr>
    </thead>
  );
}
