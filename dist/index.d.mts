import {
  a as reconcileTransfer,
  c as findMatchingKhaanTransfer,
  d as GetTransactionsOptions,
  f as KhaanTransaction,
  i as TransferReconciliationStatus,
  l as isIncoming,
  m as KhaanLoginResult,
  n as ReconcilerOptions,
  o as KhaanMatchResult,
  p as KhaanClientConfig,
  r as TransferReconciliationState,
  s as MatchedKhaanTransaction,
  t as ReconcilerHooks,
  u as KhaanClient,
} from "./orchestrator-C1gj4Pwc.mjs";

//#region src/errors.d.ts
/**
 * Base error for all khaan-client errors.
 * Carries the original Khan Bank message (Mongolian) + status code + endpoint.
 */
declare class KhaanError extends Error {
  readonly statusCode?: number;
  readonly endpoint?: string;
  constructor(
    message: string,
    opts?: {
      statusCode?: number;
      endpoint?: string;
      cause?: unknown;
    },
  );
}
/** Authentication failed — wrong username/password, invalid OTP, etc. */
declare class KhaanAuthError extends KhaanError {}
/** MFA-specific error — SOTP dispatch failed, OTP rejected, etc.
 * Extends KhaanAuthError so a single `instanceof KhaanAuthError` catches both. */
declare class KhaanMfaError extends KhaanAuthError {}
/** Generic API error — unexpected response from Khan Bank. */
declare class KhaanApiError extends KhaanError {}
/** Network error — fetch failed, timeout, DNS, etc. */
declare class KhaanNetworkError extends KhaanError {}
/** Rate limited — Khan Bank returned 429 or equivalent. */
declare class KhaanRateLimitError extends KhaanError {}
//#endregion
export {
  type GetTransactionsOptions,
  KhaanApiError,
  KhaanAuthError,
  KhaanClient,
  type KhaanClientConfig,
  KhaanError,
  type KhaanLoginResult,
  type KhaanMatchResult,
  KhaanMfaError,
  KhaanNetworkError,
  KhaanRateLimitError,
  type KhaanTransaction,
  type MatchedKhaanTransaction,
  type ReconcilerHooks,
  type ReconcilerOptions,
  type TransferReconciliationState,
  type TransferReconciliationStatus,
  findMatchingKhaanTransfer,
  isIncoming,
  reconcileTransfer,
};
