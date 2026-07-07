import { n as KhaanAuthError } from "./errors-DHX6vOcB.mjs";
//#region src/reconciliation/matching.ts
/**
 * A transaction is "incoming" if the amount is positive.
 * The Khan Bank statement API doesn't expose amount-type codes,
 * so direction is determined solely by the sign of `amount`.
 */
function isIncoming(transaction) {
  return (transaction.amount ?? 0) > 0;
}
/**
 * Find transactions matching a payment by exact amount + payment number in description.
 * Only incoming transactions (positive amount) are considered.
 *
 * Returns:
 *   - `none` — no matches
 *   - `matched` — exactly one match
 *   - `ambiguous` — two or more matches (caller must resolve manually)
 */
function findMatchingKhaanTransfer(input) {
  const paymentNumber = input.paymentNumber.trim().toUpperCase();
  const matches = input.transactions
    .filter((transaction) => {
      const amount = transaction.amount;
      const description = transaction.description?.toUpperCase() ?? "";
      return (
        amount === input.expectedAmount &&
        description.includes(paymentNumber) &&
        isIncoming(transaction)
      );
    })
    .map((transaction) => ({
      tranDate: transaction.tranDate,
      time: transaction.time,
      amount: transaction.amount ?? 0,
      description: transaction.description ?? "",
      relatedAccount: transaction.relatedAccount,
      balance: transaction.balance,
    }));
  if (matches.length === 0)
    return {
      status: "none",
      matches: [],
    };
  if (matches.length === 1)
    return {
      status: "matched",
      match: matches[0],
      matches: [matches[0]],
    };
  return {
    status: "ambiguous",
    matches,
  };
}
//#endregion
//#region src/reconciliation/orchestrator.ts
const DEFAULT_POLL_INTERVAL_MS = 25e3;
const DEFAULT_MAX_POLL_MS = 5 * 6e4;
const terminalStatuses = new Set(["confirmed", "timeout", "auth_required", "ambiguous", "failed"]);
const isTerminal = (status) => terminalStatuses.has(status);
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));
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
function reconcileTransfer(client, hooks, paymentNumber, options) {
  const pollIntervalMs = options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxPollMs = options?.maxPollMs ?? DEFAULT_MAX_POLL_MS;
  const signal = options?.signal;
  const onOtp = options?.onOtp;
  return {
    async *[Symbol.asyncIterator]() {
      const now = Date.now();
      let state = {
        paymentNumber,
        status: "polling",
        attempts: 0,
        startedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + maxPollMs).toISOString(),
        lastError: null,
      };
      let loggedIn = false;
      try {
        await client.login(onOtp ? { onOtp } : void 0);
        loggedIn = true;
      } catch (error) {
        if (error instanceof KhaanAuthError) {
          state = {
            ...state,
            status: "auth_required",
            lastError: errorMessage(error),
          };
          yield state;
          return;
        }
        state = {
          ...state,
          lastError: errorMessage(error),
        };
        yield state;
      }
      while (!isTerminal(state.status)) {
        if (signal?.aborted) {
          state = {
            ...state,
            status: "failed",
            lastError: "Aborted",
          };
          yield state;
          return;
        }
        if (Date.now() >= Date.parse(state.expiresAt)) {
          state = {
            ...state,
            status: "timeout",
            lastError: null,
          };
          await hooks.onTimeout?.(paymentNumber);
          yield state;
          return;
        }
        if (!loggedIn)
          try {
            await client.login(onOtp ? { onOtp } : void 0);
            loggedIn = true;
          } catch (error) {
            if (error instanceof KhaanAuthError) {
              state = {
                ...state,
                status: "auth_required",
                lastError: errorMessage(error),
              };
              yield state;
              return;
            }
            state = {
              ...state,
              lastError: errorMessage(error),
            };
            yield state;
            await sleep(pollIntervalMs, signal);
            continue;
          }
        state = await poll(client, hooks, state);
        yield state;
        if (state.status === "polling" && !isTerminal(state.status))
          await sleep(pollIntervalMs, signal);
      }
    },
  };
}
async function poll(client, hooks, state) {
  const attempts = state.attempts + 1;
  try {
    const payment = await hooks.getPayment(state.paymentNumber);
    if (payment.status === "not_found")
      return {
        ...state,
        status: "failed",
        attempts,
        lastError: "Payment not found",
      };
    if (payment.status === "already_confirmed")
      return {
        ...state,
        status: "confirmed",
        attempts,
        lastError: null,
      };
    const matchResult = findMatchingKhaanTransfer({
      transactions: await client.fetchTransactions(),
      paymentNumber: state.paymentNumber,
      expectedAmount: payment.expectedAmount,
    });
    if (matchResult.status === "none")
      return {
        ...state,
        attempts,
        lastError: null,
      };
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
    const confirmation = await hooks.onMatched(state.paymentNumber, matchResult.match);
    return {
      ...state,
      status: confirmation.confirmed ? "confirmed" : "failed",
      attempts,
      lastError: confirmation.confirmed ? null : (confirmation.reason ?? "Confirmation failed"),
      matchedTransaction: matchResult.match,
    };
  } catch (error) {
    if (error instanceof KhaanAuthError)
      return {
        ...state,
        status: "auth_required",
        attempts,
        lastError: errorMessage(error),
      };
    return {
      ...state,
      attempts,
      lastError: errorMessage(error),
    };
  }
}
function sleep(ms, signal) {
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
//#endregion
export { findMatchingKhaanTransfer as n, isIncoming as r, reconcileTransfer as t };
