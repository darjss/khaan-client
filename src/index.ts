// khaan-client — TypeScript SDK for Khan Bank (Khaan)
//
// Exports:
//   - KhaanClient, KhaanClientConfig, KhaanLoginResult
//   - KhaanTransaction, GetTransactionsOptions
//   - reconcileTransfer, ReconcilerHooks, ReconcilerOptions, TransferReconciliationState
//   - findMatchingKhaanTransfer, isIncoming, KhaanMatchResult, MatchedKhaanTransaction
//   - Error classes

// Client (auth + transactions)
export { KhaanClient } from "./auth/client.ts";
export type { KhaanClientConfig, KhaanLoginResult } from "./auth/types.ts";
export type { KhaanTransaction, GetTransactionsOptions } from "./transactions/types.ts";

// Reconciliation matching (pure functions)
export {
  findMatchingKhaanTransfer,
  isIncoming,
  type KhaanMatchResult,
  type MatchedKhaanTransaction,
} from "./reconciliation/matching.ts";

// Orchestrator
export {
  reconcileTransfer,
  type ReconcilerHooks,
  type ReconcilerOptions,
  type TransferReconciliationState,
  type TransferReconciliationStatus,
} from "./reconciliation/orchestrator.ts";

// Errors
export {
  KhaanError,
  KhaanAuthError,
  KhaanMfaError,
  KhaanApiError,
  KhaanNetworkError,
  KhaanRateLimitError,
} from "./errors.ts";
