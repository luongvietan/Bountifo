export type ApiErrorKind =
  | "no_token"
  | "storage_locked"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "network"
  | "http"
  | "invalid_response";

/**
 * The only error type thrown by the API layer (spec §18/§19). `message` is a
 * short static string and `status` the HTTP status when one was received —
 * NEVER request/response headers, the credential, or response-body content.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
  }
}
