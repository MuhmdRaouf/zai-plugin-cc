/** Expected failures are values. Ports and domain functions return Result; only programmer errors throw. */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

/** Marks scaffolded behaviour that a TDD slice must implement; `npm run todos` and coverage keep it honest. */
export function todo(what: string): never {
  throw new Error(`not implemented: ${what}`);
}
