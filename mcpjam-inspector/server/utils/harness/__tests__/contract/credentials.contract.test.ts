import { describe, expect, it } from "vitest";
import { HARNESS_REASONING_EFFORTS } from "@mcpjam/sdk/host-config/internal";
import { LOCAL_HARNESS_IDS } from "@/shared/harness-descriptors";
import { harnessOrgUpstream } from "@/shared/harness-model-support";
import { buildBrokerDummyAuth } from "../../registry";
import { LOCAL_HARNESS_MANIFEST } from "../../local/compatibility";
import { CASES, FOREIGN_MODEL, OWN_MODEL, assertFullMatrix } from "./support";

it("covers every registered harness", assertFullMatrix);

describe.each(CASES)(
  "$id credentials and models",
  ({ id, adapter, descriptor }) => {
    it("names one way to reach a model", () => {
      expect(adapter.modelAccess).toBe(descriptor.modelAccess);
      if (descriptor.modelAccess === "broker") {
        const auth = buildBrokerDummyAuth(id, "https://broker.test");
        expect(
          Object.values(auth).some(
            (value) =>
              typeof value === "string" &&
              value.startsWith("https://broker.test"),
          ),
        ).toBe(true);
        expect(descriptor.credential).toBeNull();
      } else {
        expect(() => buildBrokerDummyAuth(id, "https://broker.test")).toThrow(
          /external-account/,
        );
      }
    });

    it("declares its account credential once, in the descriptor", () => {
      if (descriptor.credential === null) {
        expect(adapter.externalAccountCredentialEnv).toBeUndefined();
        expect(adapter.externalAccountBrokerBinding).toBeUndefined();
        return;
      }
      const { env, binding } = descriptor.credential;
      expect(adapter.externalAccountCredentialEnv).toEqual([env]);
      expect(adapter.externalAccountBrokerBinding?.[env]).toEqual({
        hosts: [...binding.hosts],
        header: binding.header,
        template: binding.template,
      });
    });

    it("reads its organization upstream from the descriptor", () => {
      expect(harnessOrgUpstream(id)).toEqual(descriptor.orgUpstream);
    });

    it("runs its own model at the pin and refuses another vendor's", () => {
      expect(adapter.supportsModel(OWN_MODEL[id])).toBe(true);
      expect(adapter.supportsModel(FOREIGN_MODEL[id])).toBe(false);
      expect(
        adapter.supportsModel(FOREIGN_MODEL[id], { allowUnknown: true }),
      ).toBe(false);
    });

    it("offers one set of reasoning efforts", () => {
      expect(adapter.supportedReasoningEfforts).toEqual(
        HARNESS_REASONING_EFFORTS[id],
      );
      expect(descriptor.reasoningEfforts).toEqual(
        HARNESS_REASONING_EFFORTS[id],
      );
    });

    it("runs locally exactly when the descriptor and the local manifest agree", () => {
      const local = (LOCAL_HARNESS_IDS as readonly string[]).includes(id);
      expect(local).toBe(descriptor.local);
      expect(Object.hasOwn(LOCAL_HARNESS_MANIFEST, id)).toBe(descriptor.local);
      if (descriptor.modelAccess === "external-account") {
        expect(descriptor.guest).toBe(false);
        expect(descriptor.local).toBe(false);
      }
    });
  },
);
