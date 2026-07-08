export type KhaanTransaction = {
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

export type GetTransactionsOptions = {
  /** Override the account number from client config. */
  accountNumber?: string;
  /** Filter: only transactions on or after this date (inclusive). Format: ISO 8601 or YYYY-MM-DD. */
  fromDate?: string;
  /** Filter: only transactions on or before this date (inclusive). Format: ISO 8601 or YYYY-MM-DD. */
  toDate?: string;
};
