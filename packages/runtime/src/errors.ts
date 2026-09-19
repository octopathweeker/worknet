/** Public evidence/status must not echo transport URLs, request bodies or secrets. */
export function publicFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'OperationError';
  const name = /^[A-Za-z]+Error$/.test(error.name) || error.name === 'Error' ? error.name : 'OperationError';
  const code = /^[A-Z][A-Z0-9_]{2,79}$/.test(error.message) ? error.message : undefined;
  return code ? `${name}: ${code}` : name;
}
