import {
  COMPARE_PLAN_MARKETING_SECTIONS,
  type ComparePlanSection,
} from "@/components/organization/compare-plan-marketing";
import type { PlanCatalog } from "@/hooks/useOrganizationBilling";

export function buildComparePlanSectionsFromCatalog(
  _planCatalog: PlanCatalog,
): ComparePlanSection[] {
  return COMPARE_PLAN_MARKETING_SECTIONS;
}
