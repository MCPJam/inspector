/**
 * @deprecated Moved to the product-neutral home
 * `@/components/hosts/ServerGroupPicker`. This shim re-exports it under the
 * legacy `ServerAttachmentPicker` name so existing eval / chat-v2 call sites
 * keep working; migrate them to `ServerGroupPicker` opportunistically.
 */
export {
  ServerGroupPicker,
  ServerGroupPicker as ServerAttachmentPicker,
  type ServerGroup,
} from "@/components/hosts/ServerGroupPicker";
