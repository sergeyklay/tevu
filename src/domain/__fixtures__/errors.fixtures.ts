import type { TevuError, TevuResult } from '@/domain/errors';

/** Returns the value of an `ok` result and throws, naming the error, for a failure. */
export function unwrapOk<T, K extends TevuError['kind']>(result: TevuResult<T, K>): T {
  if (!result.ok) {
    throw new Error(`expected an ok result, received ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/** Returns the error of a failed result and throws for a success. */
export function unwrapError<T, K extends TevuError['kind']>(
  result: TevuResult<T, K>,
): Extract<TevuError, { kind: K }> {
  if (result.ok) {
    throw new Error('expected an error result, received success');
  }
  return result.error;
}

/** Returns the error of a failed outcome after checking that it has the given kind. */
export function unwrapErrorOfKind<K extends TevuError['kind']>(
  outcome: { ok: true; value: unknown } | { ok: false; error: TevuError },
  kind: K,
): Extract<TevuError, { kind: K }> {
  if (outcome.ok) {
    throw new Error(`expected a ${kind} failure, got success`);
  }
  if (outcome.error.kind !== kind) {
    throw new Error(`expected error kind ${kind}, got ${JSON.stringify(outcome.error)}`);
  }
  // The comparison above proves the discriminant equals `kind`, but the compiler
  // cannot relate the generic `K` to the union member it selects.
  return outcome.error as Extract<TevuError, { kind: K }>;
}
