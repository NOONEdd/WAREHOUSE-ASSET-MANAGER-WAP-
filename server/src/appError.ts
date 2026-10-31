// Expected, client-facing failures. A service throws `new AppError(code)`;
// the HTTP layer turns it into the standard error body with the status and
// the fixed message defined here. Messages are constants, never built from
// data; `details` carries only information meant for the caller (for
// example which password rules failed), never internal state.

const DEFINITIONS = {
  VALIDATION_FAILED: [400, 'Request validation failed'],
  PASSWORD_POLICY: [400, 'The new password does not meet the password policy'],
  INVALID_SETUP_CODE: [400, 'The setup code is invalid or has expired'],
  CURRENT_PASSWORD_INCORRECT: [400, 'The current password is incorrect'],
  INVALID_MFA_CODE: [400, 'The verification code is incorrect'],
  MFA_ENROLLMENT_EXPIRED: [400, 'Start setting up the authenticator app again'],
  IDEMPOTENCY_KEY_REQUIRED: [400, 'An Idempotency-Key header (UUID) is required for this request'],
  INVALID_CREDENTIALS: [401, 'Incorrect username or password'],
  UNAUTHENTICATED: [401, 'Authentication required'],
  MFA_REQUIRED: [401, 'This account requires multi-factor authentication; sign in again'],
  FORBIDDEN: [403, 'Forbidden'],
  NOT_FOUND: [404, 'Not found'],
  VERSION_CONFLICT: [409, 'The record was changed by someone else; reload it and try again'],
  USERNAME_TAKEN: [409, 'That username is already in use'],
  NAME_TAKEN: [409, 'That name is already in use'],
  CODE_TAKEN: [409, 'That code is already in use'],
  PROFILE_IN_USE: [409, 'The profile is still assigned to users'],
  MFA_ALREADY_ENROLLED: [409, 'An authenticator app is already set up for this account'],
  ADMIN_MFA_REQUIRED: [409, 'Administrator profiles require an authenticator app that is already set up'],
  WAREHOUSE_INACTIVE: [409, 'The warehouse is inactive; its assets and imports are read-only'],
  IMPORT_STATE: [409, 'The import is not in a state that allows this'],
  PERSON_ERASED: [409, 'This person has been erased and cannot be changed or chosen'],
  IMPORT_STALE: [409, 'The data changed since the preview; preview the import again'],
  IMPORT_TOO_LARGE: [422, 'An import batch may contain at most 5,000 non-empty data rows; split larger files into separate batches, each previewed and committed on its own'],
  IDEMPOTENCY_KEY_REUSED: [422, 'This Idempotency-Key was already used for a different request'],
  MFA_LOCKED: [423, 'Too many incorrect verification codes; ask an administrator to reset your sign-in'],
  TOO_MANY_REQUESTS: [429, 'Too many attempts; try again later']
} as const satisfies Record<string, readonly [number, string]>

export type AppErrorCode = keyof typeof DEFINITIONS

export class AppError extends Error {
  readonly code: AppErrorCode
  readonly status: number
  readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(code: AppErrorCode, details?: Readonly<Record<string, unknown>>) {
    const [status, message] = DEFINITIONS[code]
    super(message)
    this.name = 'AppError'
    this.code = code
    this.status = status
    this.details = details
  }
}
