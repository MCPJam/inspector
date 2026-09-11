import { expect, it, vi } from "vitest";
import * as appNavigation from "@/lib/app-navigation";
import { createPlaygroundSuiteNavigation } from "../create-suite-navigation";

it("opens case UVC overrides under Evaluate and returns to the case", () => {
  const navigate = vi.spyOn(appNavigation, "navigateApp").mockImplementation(() => undefined);
  const navigation = createPlaygroundSuiteNavigation();
  navigation.toTestEdit("suite-1", "case-1", { checks: true });
  expect(navigate).toHaveBeenLastCalledWith("/evaluate/suite/suite-1/test/case-1/edit?checks=1", {replace: undefined});
  navigation.toTestEdit("suite-1", "case-1");
  expect(navigate).toHaveBeenLastCalledWith("/evaluate/suite/suite-1/test/case-1/edit", {replace: undefined});
});
