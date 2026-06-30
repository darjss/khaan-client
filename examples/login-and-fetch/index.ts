/**
 * Example: login to Khan Bank, fetch transactions, test re-login, and run
 * reconciliation matching against a fake payment.
 *
 * Run:
 *   pnpm tsx examples/login-and-fetch/index.ts
 *
 * Requires env vars (copy from vit-store .env):
 *   KHAAN_USERNAME, KHAAN_PASSWORD, KHAAN_DEVICE_ID,
 *   KHAAN_ACCOUNT_NUMBER, KHAAN_USER_AGENT (optional)
 */
import {
  KhaanClient,
  KhaanError,
  findMatchingKhaanTransfer,
  isIncoming,
  type KhaanTransaction,
} from "../../src/index.ts";

const env = process.env;

const client = new KhaanClient({
  username: env.KHAAN_USERNAME!,
  password: env.KHAAN_PASSWORD!,
  deviceId: env.KHAAN_DEVICE_ID!,
  accountNumber: env.KHAAN_ACCOUNT_NUMBER!,
  userAgent: env.KHAAN_USER_AGENT,
  branchCode: env.KHAAN_BRANCH_CODE,
});

async function main() {
  console.log("=== Step 1: Login ===");
  const { accessToken } = await client.login({
    onOtp: async (requestId) => {
      console.log(`\nOTP required (requestId: ${requestId}).`);
      console.log("Check your phone for the SMS code.");
      process.stdout.write("Enter OTP: ");
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
        if (chunk.includes(0x0a)) break; // newline
      }
      return Buffer.concat(chunks).toString().trim();
    },
  });
  console.log(`Login OK. Token: ${accessToken.slice(0, 20)}...`);

  console.log("\n=== Step 2: Fetch transactions ===");
  const transactions = await client.fetchTransactions();
  console.log(`Got ${transactions.length} transactions\n`);
  printTransactions(transactions);

  console.log("\n=== Step 3: Force re-login (token renewal) ===");
  // The Khan Bank API's refresh_token endpoint is non-functional, so the SDK
  // re-logins using the remembered device instead. This tests that path.
  const anyClient = client as unknown as { reLogin(): Promise<void> };
  await anyClient.reLogin();
  console.log("Re-login succeeded — new token obtained without OTP.");

  console.log("\n=== Step 4: Fetch after re-login ===");
  const txs2 = await client.fetchTransactions();
  console.log(`Got ${txs2.length} transactions (should match step 2)`);

  console.log("\n=== Step 5: Reconciliation matching ===");
  // Find an incoming transaction to use as a fake "payment" for reconciliation testing
  const incoming = transactions.filter(isIncoming);
  if (incoming.length === 0) {
    console.log("No incoming transactions found — skipping reconciliation test.");
    return;
  }

  const target = incoming[0];
  // Extract a substring from the description to use as a fake payment number
  const paymentNumber = (target.description ?? "").slice(0, 10).toUpperCase().trim();
  const expectedAmount = target.amount ?? 0;

  console.log(`Looking for payment: "${paymentNumber}" amount: ${expectedAmount}`);

  const matchResult = findMatchingKhaanTransfer({
    transactions,
    paymentNumber,
    expectedAmount,
  });

  if (matchResult.status === "matched") {
    console.log(`✅ Matched: ${matchResult.match.description} (${matchResult.match.amount})`);
  } else if (matchResult.status === "ambiguous") {
    console.log(`⚠️  Ambiguous: ${matchResult.matches.length} matches found`);
    for (const m of matchResult.matches) {
      console.log(`   - ${m.description} (${m.amount})`);
    }
  } else {
    console.log(`❌ No match found (payment number may not appear in description)`);
  }

  console.log("\n=== Step 6: getTransactions with date filter ===");
  const fromDate = "2026-06-10";
  const toDate = "2026-06-30";
  console.log(`Filtering ${fromDate} to ${toDate}...`);
  const filtered = await client.getTransactions({ fromDate, toDate });
  console.log(`Got ${filtered.length} transactions in range\n`);
  printTransactions(filtered);

  console.log("\n✅ All steps completed successfully");
}

function printTransactions(transactions: KhaanTransaction[]): void {
  console.log("Date            | Amount        | Description");
  console.log("----------------|---------------|---------------------------");
  for (const tx of transactions) {
    const date = `${tx.tranDate ?? "—"} ${tx.time ?? ""}`.trim();
    const amount = tx.amount?.toLocaleString() ?? "—";
    const desc = tx.description ?? "—";
    console.log(`${date.padEnd(16)}| ${amount.padEnd(14)}| ${desc}`);
  }
}

void main().catch((error) => {
  if (error instanceof KhaanError) {
    console.error(`\n❌ Khaan error: ${error.message}`);
    console.error(`  status: ${error.statusCode ?? "n/a"}`);
    console.error(`  endpoint: ${error.endpoint ?? "n/a"}`);
  } else {
    console.error("Unexpected error:", error);
  }
  process.exit(1);
});
