//#region src/auth/types.d.ts
type KhaanClientConfig = {
  username: string;
  password: string;
  deviceId: string;
  userAgent?: string;
  accountNumber: string;
  branchCode?: string;
};
type KhaanLoginResult = {
  status: "logged_in";
  accessToken: string;
} | {
  status: "mfa_required";
  requestId: string;
};
//#endregion
//#region src/transactions/types.d.ts
type KhaanTransaction = {
  tranDate?: string;
  time?: string;
  amount?: number;
  description?: string;
  balance?: number;
  relatedAccount?: string;
  currency?: string;
  code?: string;
  refId?: string;
};
type GetTransactionsOptions = {
  /** Override the account number from client config. */accountNumber?: string; /** Filter: only transactions on or after this date (inclusive). Format: ISO 8601 or YYYY-MM-DD. */
  fromDate?: string; /** Filter: only transactions on or before this date (inclusive). Format: ISO 8601 or YYYY-MM-DD. */
  toDate?: string;
};
//#endregion
//#region src/auth/client.d.ts
/**
 * Deep module: Khan Bank API client.
 *
 * Interface: `login()`, `loginInitial()`, `dispatchOtp()`, `submitOtp()`,
 * `fetchTransactions()`, `getTransactions()`.
 * Implementation: 3-step SOTP flow, base64 encoding, token caching + reactive re-login,
 * ky hooks for auth injection + 401-retry + error classification, valibot validation.
 *
 * NOTE: The Khan Bank API returns a `refresh_token` in login responses, but the
 * Apigee gateway's refresh endpoint is non-functional (returns `invalid_request`
 * for all attempts). Token renewal is done via re-login using the remembered
 * device (set via `rememberDevice: "Y"` in step 3 of SOTP), which completes in
 * a single step without OTP.
 *
 * Re-login is REACTIVE only — triggered by a 401 response, not proactively
 * before token expiry. This minimizes password-based logins to avoid rate
 * limiting (429) and suspicious-activity flags. A token that lasts 5 minutes
 * with 25-second polling means at most 1 re-login per 5 minutes (~12/hour).
 */
declare class KhaanClient {
  private readonly config;
  private readonly http;
  private tokenState;
  /** In-flight re-login promise — dedupes concurrent 401s and prevents loops. */
  private reLoginPromise;
  constructor(config: KhaanClientConfig);
  /**
   * High-level login: runs all 3 SOTP steps if needed.
   * If the device is already remembered, completes in one step (no onOtp call).
   * If MFA is required and `onOtp` is provided, dispatches SOTP, calls `onOtp`
   * to get the code, then submits + remembers the device.
   * If MFA is required and `onOtp` is absent, throws `KhaanMfaError`.
   */
  login(options?: {
    onOtp?: (requestId: string) => Promise<string>;
  }): Promise<{
    accessToken: string;
  }>;
  /** Step 1: initial login. Returns mfa_required + requestId if MFA needed. */
  loginInitial(): Promise<KhaanLoginResult>;
  /** Step 2: dispatch SOTP to the user's registered phone/email. */
  dispatchOtp(requestId: string): Promise<void>;
  /** Step 3: submit OTP + rememberDevice. Returns tokens. */
  submitOtp(requestId: string, otp: string): Promise<{
    accessToken: string;
  }>;
  /**
   * Fetch recent transactions (~10 latest) for the configured account.
   * Auth injection and token re-login are handled by ky hooks.
   */
  fetchTransactions(): Promise<KhaanTransaction[]>;
  /**
   * Fetch transactions with optional client-side date filtering and account override.
   *
   * The Khan Bank API only exposes a "recent" endpoint (~10 latest) — no
   * server-side date range. `fromDate`/`toDate` filter the results client-side.
   * Useful for reconciliation polling where you only care about a specific window.
   */
  getTransactions(options?: GetTransactionsOptions): Promise<KhaanTransaction[]>;
  private requireLoggedIn;
  private reLogin;
  private setTokenState;
  private postToken;
  private baseHeaders;
}
//#endregion
//#region src/reconciliation/matching.d.ts
type MatchedKhaanTransaction = {
  tranDate?: string;
  time?: string;
  amount: number;
  description: string;
  relatedAccount?: string;
  balance?: number;
};
type KhaanMatchResult = {
  status: "none";
  matches: [];
} | {
  status: "matched";
  match: MatchedKhaanTransaction;
  matches: [MatchedKhaanTransaction];
} | {
  status: "ambiguous";
  matches: MatchedKhaanTransaction[];
};
/**
 * A transaction is "incoming" if the amount is positive.
 * The Khan Bank statement API doesn't expose amount-type codes,
 * so direction is determined solely by the sign of `amount`.
 */
declare function isIncoming(transaction: KhaanTransaction): boolean;
/**
 * Find transactions matching a payment by exact amount + payment number in description.
 * Only incoming transactions (positive amount) are considered.
 *
 * Returns:
 *   - `none` — no matches
 *   - `matched` — exactly one match
 *   - `ambiguous` — two or more matches (caller must resolve manually)
 */
declare function findMatchingKhaanTransfer(input: {
  transactions: KhaanTransaction[];
  paymentNumber: string;
  expectedAmount: number;
}): KhaanMatchResult;
//#endregion
//#region src/reconciliation/orchestrator.d.ts
type TransferReconciliationStatus = "polling" | "matched" | "confirmed" | "timeout" | "auth_required" | "ambiguous" | "failed";
type TransferReconciliationState = {
  paymentNumber: string;
  status: TransferReconciliationStatus;
  attempts: number;
  startedAt: string;
  expiresAt: string;
  matchedTransaction?: MatchedKhaanTransaction;
  lastError: string | null;
};
type ReconcilerHooks = {
  /** Is this payment still pending? What amount do we expect? */getPayment: (paymentNumber: string) => Promise<{
    status: "confirmable";
    expectedAmount: number;
  } | {
    status: "already_confirmed";
  } | {
    status: "not_found";
  }>; /** A unique match was found. Confirm + notify. Return whether confirmation succeeded. */
  onMatched: (paymentNumber: string, match: MatchedKhaanTransaction) => Promise<{
    confirmed: boolean;
    reason?: string;
  }>; /** Multiple matches — caller must resolve manually. */
  onAmbiguous?: (paymentNumber: string, matches: MatchedKhaanTransaction[]) => Promise<void>; /** Timed out without a match. */
  onTimeout?: (paymentNumber: string) => Promise<void>;
};
type ReconcilerOptions = {
  pollIntervalMs?: number;
  maxPollMs?: number;
  signal?: AbortSignal; /** OTP callback — if login requires MFA. If omitted and MFA is needed, status becomes auth_required. */
  onOtp?: (requestId: string) => Promise<string>;
};
/**
 * Deep module: polling orchestrator for transfer reconciliation.
 *
 * Interface: one async iterable. Caller does `for await (const state of reconcileTransfer(...))`.
 * Implementation: login (with SOTP if needed), token reuse + auto-refresh across polls,
 * poll loop, fetch transactions, match, hook dispatch, abort, retry, state tracking.
 *
 * Yields a `TransferReconciliationState` after every poll cycle and on terminal status.
 * The iterator ends after yielding a terminal state.
 */
declare function reconcileTransfer(client: KhaanClient, hooks: ReconcilerHooks, paymentNumber: string, options?: ReconcilerOptions): AsyncIterable<TransferReconciliationState>;
//#endregion
export { reconcileTransfer as a, findMatchingKhaanTransfer as c, GetTransactionsOptions as d, KhaanTransaction as f, TransferReconciliationStatus as i, isIncoming as l, KhaanLoginResult as m, ReconcilerOptions as n, KhaanMatchResult as o, KhaanClientConfig as p, TransferReconciliationState as r, MatchedKhaanTransaction as s, ReconcilerHooks as t, KhaanClient as u };