import * as v from "valibot";

// --- Error response ---

export const ErrorResponseSchema = v.object({
  message: v.optional(v.string()),
  error: v.optional(v.string()),
  code: v.optional(v.string()),
});

// --- Auth / login ---

export const LoginResponseSchema = v.object({
  access_token: v.optional(v.string()),
  access_token_expires_in: v.optional(v.string()),
  refresh_token: v.optional(v.string()),
  refresh_token_status: v.optional(v.string()),
  refresh_token_expires_in: v.optional(v.string()),
  display_name: v.optional(v.string()),
  primary_account_id: v.optional(v.string()),
  unique_id: v.optional(v.string()),
  message: v.optional(v.string()),
});

export type LoginResponseBody = v.InferOutput<typeof LoginResponseSchema>;

// --- Transactions ---

export const TransactionSchema = v.object({
  tranDate: v.optional(v.string()),
  time: v.optional(v.string()),
  amount: v.optional(v.number()),
  description: v.optional(v.string()),
  balance: v.optional(v.number()),
  relatedAccount: v.optional(v.string()),
  currency: v.optional(v.string()),
  code: v.optional(v.string()),
  refId: v.optional(v.string()),
});

export const TransactionListSchema = v.array(TransactionSchema);
