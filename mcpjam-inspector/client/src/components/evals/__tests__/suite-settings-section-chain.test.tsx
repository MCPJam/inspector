import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SuiteSettingsChainNode,
  SuiteSettingsSectionChain,
} from "../suite-settings-section-chain";
import { SuiteSettingsRow } from "../suite-settings-row";

describe("SuiteSettingsSectionChain", () => {
  it("renders one spine and a node per chained section", () => {
    const { container } = render(
      <SuiteSettingsSectionChain>
        <SuiteSettingsRow settingKey="policy" hint="How each case is decided.">
          <div>body</div>
        </SuiteSettingsRow>
        <section className="relative scroll-mt-6 pb-10">
          <SuiteSettingsChainNode />
          <h3>Connection</h3>
        </section>
      </SuiteSettingsSectionChain>,
    );
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
    expect(container.querySelector(".absolute.bottom-6.left-\\[0\\.9375rem\\]")).toBeTruthy();
  });
});
