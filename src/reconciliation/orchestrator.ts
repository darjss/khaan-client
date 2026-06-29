import type { KhaanClient, KhaanTransaction } from "../auth/client.ts";
import { KhaanAuthError, KhaanMfaError } from "../errors.ts";
import { type MatchedKhaanTransaction, findMatchingKhaanTransfer } from "./matching.ts";

// --- Types (public) ---------------------------------------------------------

export type TransferReconciliationStatus =
  | "polling"
  | "matched"
  | "confirmed"
  | "timeout"
  | "auth_required"
  | "ambiguous"
  | "failed";

export type TransferReconciliationState = {
  paymentNumber: string;
  status: TransferReconciliationStatus;
  attempts: number;
  startedAt: string;
  expiresAt: string;
  matchedTransaction?: MatchedKhaanTransaction;
  lastError: string | null;
};

export type ReconcilerHooks = {
  /** Is this payment still pending? What amount do we expect? */
  getPayment: (
    paymentNumber: string,
  ) => Promise<
    | { status: "confirmable"; expectedAmount: number }
    | { status: "already_confirmed" }
    | { status: "not_found" }
  >;

  /** A unique match was found. Confirm + notify. Return whether confirmation succeeded. */
  onMatched: (
    paymentNumber: string,
    match: MatchedKhaanTransaction,
  ) => Promise<{ confirmed: boolean; reason?: string }>;

  /** Multiple matches — caller must resolve manually. */
  onAmbiguous?: (paymentNumber: string, matches: MatchedKhaanTransaction[]) => Promise<void>;

  /** Timed out without a match. */
  onTimeout?: (paymentNumber: string) => Promise<void>;
};

export type ReconcilerOptions = {
  pollIntervalMs?: number;
  maxPollMs?: number;
  signal?: AbortSignal;
  /** OTP callback — if login requires MFA. If omitted and MFA is needed, status becomes auth_required. */
  onOtp?: (requestId: string) => Promise<string>;
};

// --- Constants --------------------------------------------------------------

const DEFAULT_POLL_INTERVAL_MS = 25_000;
const DEFAULT_MAX_POLL_MS = 5 * 60_000;

const terminalStatuses = new Set<TransferReconciliationStatus>([
  "confirmed",
  "timeout",
  "auth_required",
  "ambiguous",
  "failed",
]);

const isTerminal = (status: TransferReconciliationStatus) => terminalStatuses.has(status);

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// --- Orchestrator -----------------------------------------------------------

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
export function reconcileTransfer(
  client: KhaanClient,
  hooks: ReconcilerHooks,
  paymentNumber: string,
  options?: ReconcilerOptions,
): AsyncIterable<TransferReconciliationState> {
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollMs = options?.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  const signal = options?.signal;
  const onOtp = options?.onOtp;

  return {
    async *[Symbol.asyncIterator](): AsyncGenerator<TransferReconciliationState> {
      const now = Date.now();
      let state: TransferReconciliationState = {
        paymentNumber,
        status: "polling",
        attempts: 0,
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + maxPollMs).toISOString(),
        lastError: null,
      };

      // Login once at the start — reuse token across all polls
      try {
        await client.login(onOtp ? { onOtp } : undefined);
      } catch (error) {
        if (error instanceof KhaanMfaError) {
          state = { ...state, status: "auth_required", lastError: errorMessage(error) };
          yield state;
          return;
        }
        if (error instanceof KhaanAuthError) {
          state = { ...state, status: "auth_required", lastError: errorMessage(error) };
          yield state;
          return;
        }
        // Non-auth error — yield polling state with error, will retry login next cycle
        state = { ...state, lastError: errorMessage(error) };
        yield state;
      }

      while (!isTerminal(state.status)) {
        if (signal?.aborted) {
          state = { ...state, status: "failed", lastError: "Aborted" };
          yield state;
          return;
        }

        if (Date.now() >= Date.parse(state.expiresAt)) {
          state = { ...state, status: "timeout", lastError: null };
          await hooks.onTimeout?.(paymentNumber);
          yield state;
          return;
        }

        state = await poll(client, hooks, state);
        yield state;

        // If still polling, wait for the next interval
        if (state.status === "polling" && !isTerminal(state.status)) {
          await sleep(pollIntervalMs, signal);
        }
      }
    },
  };
}

// --- Internal: single poll cycle ---

async function poll(
  client: KhaanClient,
  hooks: ReconcilerHooks,
  state: TransferReconciliationState,
): Promise<TransferReconciliationState> {
  const attempts = state.attempts + 1;

  try {
    // 1. Check payment status with the caller's app
    const payment = await hooks.getPayment(state.paymentNumber);
    if (payment.status === "not_found") {
      return {
        ...state,
        status: "failed",
        attempts,
        lastError: "Payment not found",
      };
    }
    if (payment.status === "already_confirmed") {
      return {
        ...state,
        status: "confirmed",
        attempts,
        lastError: null,
      };
    }

    // 2. Fetch transactions + match
    const transactions: KhaanTransaction[] = await client.fetchTransactions();
    const matchResult = findMatchingKhaanTransfer({
      transactions,
      paymentNumber: state.paymentNumber,
      expectedAmount: payment.expectedAmount,
    });

    if (matchResult.status === "none") {
      return { ...state, attempts, lastError: null };
    }

    if (matchResult.status === "ambiguous") {
      await hooks.onAmbiguous?.(state.paymentNumber, matchResult.matches);
      return {
        ...state,
        status: "ambiguous",
        attempts,
        lastError: null,
        matchedTransaction: matchResult.matches[0],
      };
    }

    // 3. Matched — confirm via caller's hook
    const confirmation = await hooks.onMatched(state.paymentNumber, matchResult.match);

    return {
      ...state,
      status: confirmation.confirmed ? "confirmed" : "failed",
      attempts,
      lastError: confirmation.confirmed ? null : (confirmation.reason ?? "Confirmation failed"),
      matchedTransaction: matchResult.match,
    };
  } catch (error) {
    // Auth errors are terminal — caller needs to re-login
    if (error instanceof KhaanAuthError) {
      return {
        ...state,
        status: "auth_required",
        attempts,
        lastError: errorMessage(error),
      };
    }
    // Network/API errors — retry next cycle
    return { ...state, attempts, lastError: errorMessage(error) };
  }
}

// --- Internal: sleep with abort ---

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
