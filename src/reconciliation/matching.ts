import type { KhaanTransaction } from "../auth/client.ts";

// --- Types (public) ---------------------------------------------------------

export type MatchedKhaanTransaction = {
  tranDate?: string;
  time?: string;
  amount: number;
  description: string;
  relatedAccount?: string;
  balance?: number;
};

export type KhaanMatchResult =
  | { status: "none"; matches: [] }
  | {
      status: "matched";
      match: MatchedKhaanTransaction;
      matches: [MatchedKhaanTransaction];
    }
  | { status: "ambiguous"; matches: MatchedKhaanTransaction[] };

// --- Pure functions ---------------------------------------------------------

/**
 * A transaction is "incoming" if the amount is positive.
 * The Khan Bank statement API doesn't expose amount-type codes,
 * so direction is determined solely by the sign of `amount`.
 */
export function isIncoming(transaction: KhaanTransaction): boolean {
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
export function findMatchingKhaanTransfer(input: {
  transactions: KhaanTransaction[];
  paymentNumber: string;
  expectedAmount: number;
}): KhaanMatchResult {
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

  if (matches.length === 0) {
    return { status: "none", matches: [] };
  }
  if (matches.length === 1) {
    return { status: "matched", match: matches[0], matches: [matches[0]] };
  }
  return { status: "ambiguous", matches };
}
