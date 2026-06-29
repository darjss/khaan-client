// khaan-client/reconciliation — sub-export for matching logic + orchestrator
//
// Useful when callers only need the pure matching functions without pulling
// the full client + orchestrator.

export {
  findMatchingKhaanTransfer,
  isIncoming,
  type KhaanMatchResult,
  type MatchedKhaanTransaction,
} from "./matching.ts";

export {
  reconcileTransfer,
  type ReconcilerHooks,
  type ReconcilerOptions,
  type TransferReconciliationState,
  type TransferReconciliationStatus,
} from "./orchestrator.ts";
