# Centralized user-facing errors

Provide one editable catalog of Inspector user-facing error messages. Presentation
boundaries must use catalog messages, with a safe default for unexpected backend
errors. Keep diagnostic errors available for debugging without presenting them as
product guidance. Review copy for a clear outcome and a useful recovery action.

## User stories

- [ ] Users receive clear guidance when an operation fails.
- [ ] Unexpected backend failures show a safe, consistent fallback.
- [ ] Maintainers can review and edit user-facing error copy in one file.

## Validation

- [ ] Known failures resolve to the intended catalog message.
- [ ] Unknown errors and backend text cannot leak through the presentation service.
- [ ] Migrated failure flows preserve successful behavior and recovery actions.
