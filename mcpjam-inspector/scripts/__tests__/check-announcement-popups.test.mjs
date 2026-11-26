import assert from "node:assert/strict";
import { test } from "node:test";
import { checkAnnouncementPopups } from "../../client/scripts/check-announcement-popups.mjs";

const check = (code) => checkAnnouncementPopups("components/example.tsx", code);

test("exempts the shared wrapper with POSIX and Windows paths", () => {
  const code = 'import { toast } from "sonner"; toast.custom(() => null);';
  for (const file of [
    "components/announcement-popups.tsx",
    "components\\announcement-popups.tsx",
  ]) {
    assert.deepEqual(checkAnnouncementPopups(file, code), []);
  }
});

test("flags direct custom toasts and feature spotlight roots even if aliased", () => {
  const violations = check(`
    import { toast as notify } from "sonner";
    import * as UI from "@mcpjam/design-system/feature-spotlight";
    notify.custom(() => <div />);
    const popup = <UI.FeatureSpotlight open={isEligible} />;
  `);
  assert.match(violations[0], /:4: Use AnnouncementToast/);
  assert.match(violations[1], /:5: Use AnnouncementSpotlight/);
});

test("flags default-open dialogs and popovers, including a Radix root", () => {
  const violations = check(`
    import { Dialog as Modal } from "@mcpjam/design-system/dialog";
    import { Popover } from "radix-ui";
    const a = <Modal defaultOpen />;
    const b = <Modal defaultOpen={true} />;
    const c = <Popover.Root defaultOpen={firstVisit} />;
  `);
  assert.equal(violations.length, 3);
  assert.ok(violations.every((violation) => violation.includes("Queue auto-opening")));
});

test("leaves controlled dialogs, normal feedback toasts, and queued surfaces alone", () => {
  assert.deepEqual(check(`
    import { Dialog } from "@mcpjam/design-system/dialog";
    import { FeatureSpotlightTitle } from "@mcpjam/design-system/feature-spotlight";
    import { AnnouncementSpotlight, AnnouncementToast } from "./announcement-popups";
    import { toast } from "sonner";
    const confirm = <Dialog open={confirming} defaultOpen={false} />;
    const requiredApproval = showApproval ? <Dialog open /> : null;
    const spotlight = <AnnouncementSpotlight><FeatureSpotlightTitle /></AnnouncementSpotlight>;
    const nudge = <AnnouncementToast />;
    toast.success("Saved");
  `), []);
});
