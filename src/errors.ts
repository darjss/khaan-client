/**
 * Base error for all khaan-client errors.
 * Carries the original Khan Bank message (Mongolian) + status code + endpoint.
 */
export class KhaanError extends Error {
  readonly statusCode?: number;
  readonly endpoint?: string;

  constructor(message: string, opts?: { statusCode?: number; endpoint?: string; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = this.constructor.name;
    this.statusCode = opts?.statusCode;
    this.endpoint = opts?.endpoint;
  }
}

/** Authentication failed — wrong username/password, invalid OTP, etc. */
export class KhaanAuthError extends KhaanError {}

/** MFA-specific error — SOTP dispatch failed, OTP rejected, etc.
 * Extends KhaanAuthError so a single `instanceof KhaanAuthError` catches both. */
export class KhaanMfaError extends KhaanAuthError {}

/** Generic API error — unexpected response from Khan Bank. */
export class KhaanApiError extends KhaanError {}

/** Network error — fetch failed, timeout, DNS, etc. */
export class KhaanNetworkError extends KhaanError {}

/** Rate limited — Khan Bank returned 429 or equivalent. */
export class KhaanRateLimitError extends KhaanError {}
