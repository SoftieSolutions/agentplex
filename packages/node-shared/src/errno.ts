/**
 * Node's errno is a property on a thrown value, not a type.
 *
 * `NodeJS.ErrnoException` describes what an fs or net call usually throws, but
 * nothing checks that a given `catch` received one, and a cast to it is an
 * assertion the compiler takes on trust. These read the code as a claim: a
 * value that is not an object, or whose `code` is not a string, has no errno.
 */
export function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function isErrno(error: unknown, code: string): boolean {
  return errnoCode(error) === code;
}
