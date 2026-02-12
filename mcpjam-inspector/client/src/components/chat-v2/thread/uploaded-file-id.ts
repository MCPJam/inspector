const UPLOADED_FILE_ID_PATTERN = /^file_[0-9a-f-]+$/;

export function isValidUploadedFileId(fileId: unknown): fileId is string {
  return typeof fileId === "string" && UPLOADED_FILE_ID_PATTERN.test(fileId);
}
