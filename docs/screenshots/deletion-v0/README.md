# Organization deletion UI review

These images render the PR's React components and shared design-system styles with synthetic organization data. The Danger Zone preview uses the JSX from `OrganizationsTab`; the before dialog is from the base branch. The isolated preview supplies pending-query and cancellation responses and does not contact a backend.

- `danger-before.png` / `danger-after.png`: permanent deletion and 48-hour cancellation copy.
- `dialog-before.png` / `dialog-after.png`: confirmation dialog.
- `banner.png`: pending deletion and deadline.
- `cancel-error.png`: rejected cancellation leaves the banner available.
- `cancel.webm`: failed cancellation followed by a successful retry (under 60 seconds).

This is visual/component evidence. Deployment-order and signed-in backend smoke tests remain rollout checks.
