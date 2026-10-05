/** A listen that the server refused, named after the caller that asked. */
export class ListenError extends Error {
  readonly code: string;
  readonly identifier: string | undefined;
  readonly path: string;
  readonly cause: unknown;

  constructor(code: string, message: string, details: { identifier: string | undefined; path: string; cause: unknown }) {
    super(message);
    this.name = 'ListenError';
    this.code = code;
    this.identifier = details.identifier;
    this.path = details.path;
    this.cause = details.cause;
  }
}

/** A query the chosen backend cannot run. Thrown from `listen`, before anything connects. */
export class UnsupportedQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedQueryError';
  }
}

/** What Firestore says when asked to scan keys backwards on their own, which the emulator refuses. */
const DESCENDING_KEY_SCAN = /descending key scans/i;
const PERMISSION_CODE = /^permission[-_ ]denied$/i;
const PERMISSION_MESSAGE = /permission[-_ ]denied/i;

function isPermissionDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (typeof code === 'string' && PERMISSION_CODE.test(code)) return true;
  return typeof message === 'string' && PERMISSION_MESSAGE.test(message);
}

/**
 * A denied listen or get becomes
 * `PERMISSION_DENIED: Permission denied (listen --- <identifier>): <server message> --- <path>`.
 * Any other error is passed through untouched.
 */
export function nameListenError(
  error: unknown,
  details: { identifier: string | undefined; path: string; action?: 'listen' | 'get' },
): unknown {
  const original = error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? error);
  if (DESCENDING_KEY_SCAN.test(original)) {
    return new UnsupportedQueryError(
      `${original}. The query orders by the key, highest first, with a limit or a cursor, and nothing narrows it. Firestore's index documentation says the key in its non-default direction needs an index created for it. Order by the key ascending, add an equality filter, or read without a limit and let the order run here.`,
    );
  }
  if (!isPermissionDenied(error)) return error;
  const action = details.action ?? 'listen';
  const caller = details.identifier ? `${action} --- ${details.identifier}` : action;
  return new ListenError('PERMISSION_DENIED', `PERMISSION_DENIED: Permission denied (${caller}): ${original} --- ${details.path}`, {
    identifier: details.identifier,
    path: details.path,
    cause: error,
  });
}
