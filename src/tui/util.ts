/**
 * Extracts the message from an error object, falling back to string coercion.
 */
export function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
