/** The `code` of a Node system error (ENOENT, EPERM, ...), if it has one. */
export function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
