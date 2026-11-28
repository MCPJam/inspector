---
"@mcpjam/inspector": patch
---

Organization admins can upgrade their organization's plan. Upgrade buttons on the Plans page, the limit dialogs and the shared-settings upsell now follow the backend's `canUpgradePlan`, falling back to `canManageBilling` when the backend does not send it. Downgrades, billing-interval changes, cancellation and the billing portal stay with owners.
