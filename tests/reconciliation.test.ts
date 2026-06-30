import { expect, test, describe } from "vite-plus/test";
import type { KhaanTransaction } from "../src/transactions/types.ts";
import { findMatchingKhaanTransfer, isIncoming } from "../src/reconciliation/matching.ts";

const transaction = (overrides: Partial<KhaanTransaction> = {}): KhaanTransaction => ({
  tranDate: "2026-06-28T00:00:00Z",
  time: "18:30",
  amount: 125000,
  description: "PAYABC1234",
  balance: 21167.84,
  ...overrides,
});

describe("Khaan transfer reconciliation matching", () => {
  test("matches one incoming transaction by exact amount and payment number", () => {
    const result = findMatchingKhaanTransfer({
      transactions: [
        transaction({ description: "other" }),
        transaction({ description: "payment PAYABC1234 thank you" }),
      ],
      paymentNumber: "PAYABC1234",
      expectedAmount: 125000,
    });

    expect(result.status).toBe("matched");
    if (result.status === "matched") {
      expect(result.match.amount).toBe(125000);
      expect(result.match.description).toContain("PAYABC1234");
    }
  });

  test("rejects amount, direction, and description mismatches", () => {
    const result = findMatchingKhaanTransfer({
      transactions: [
        transaction({ amount: 124999 }),
        transaction({ amount: -125000 }),
        transaction({ description: "customer phone 99112233" }),
      ],
      paymentNumber: "PAYABC1234",
      expectedAmount: 125000,
    });

    expect(result).toEqual({ status: "none", matches: [] });
  });

  test("marks multiple plausible matches as ambiguous", () => {
    const result = findMatchingKhaanTransfer({
      transactions: [
        transaction({ description: "PAYABC1234 first" }),
        transaction({ description: "PAYABC1234 second" }),
      ],
      paymentNumber: "PAYABC1234",
      expectedAmount: 125000,
    });

    expect(result.status).toBe("ambiguous");
    if (result.status === "ambiguous") {
      expect(result.matches).toHaveLength(2);
    }
  });

  test("recognizes incoming transactions by positive amount", () => {
    expect(isIncoming(transaction())).toBe(true);
    expect(isIncoming(transaction({ amount: -125000 }))).toBe(false);
  });
});
