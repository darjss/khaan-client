//#region src/errors.ts
/**
 * Base error for all khaan-client errors.
 * Carries the original Khan Bank message (Mongolian) + status code + endpoint.
 */
var KhaanError = class extends Error {
  statusCode;
  endpoint;
  constructor(message, opts) {
    super(message, opts?.cause !== void 0 ? { cause: opts.cause } : void 0);
    this.name = this.constructor.name;
    this.statusCode = opts?.statusCode;
    this.endpoint = opts?.endpoint;
  }
};
/** Authentication failed — wrong username/password, invalid OTP, etc. */
var KhaanAuthError = class extends KhaanError {};
/** MFA-specific error — SOTP dispatch failed, OTP rejected, etc.
 * Extends KhaanAuthError so a single `instanceof KhaanAuthError` catches both. */
var KhaanMfaError = class extends KhaanAuthError {};
/** Generic API error — unexpected response from Khan Bank. */
var KhaanApiError = class extends KhaanError {};
/** Network error — fetch failed, timeout, DNS, etc. */
var KhaanNetworkError = class extends KhaanError {};
/** Rate limited — Khan Bank returned 429 or equivalent. */
var KhaanRateLimitError = class extends KhaanError {};
//#endregion
export {
  KhaanNetworkError as a,
  KhaanMfaError as i,
  KhaanAuthError as n,
  KhaanRateLimitError as o,
  KhaanError as r,
  KhaanApiError as t,
};
