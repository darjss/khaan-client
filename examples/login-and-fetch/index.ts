/**
 * Example: login to Khan Bank and fetch recent transactions.
 *
 * Run:
 *   pnpm tsx examples/login-and-fetch/index.ts
 *
 * Requires env vars (copy from vit-store .env):
 *   KHAAN_USERNAME, KHAAN_PASSWORD, KHAAN_DEVICE_ID,
 *   KHAAN_ACCOUNT_NUMBER, KHAAN_USER_AGENT (optional)
 */
import { KhaanClient, KhaanError } from "../../src/index.ts";

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
  console.log("Logging in...");

  try {
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

    console.log(`\nLogin successful. Token: ${accessToken.slice(0, 20)}...`);

    console.log("\nFetching recent transactions...");
    const transactions = await client.fetchTransactions();

    console.log(`\nGot ${transactions.length} transactions:\n`);
    console.log("Date            | Amount        | Description");
    console.log("----------------|---------------|---------------------------");
    for (const tx of transactions) {
      const date = `${tx.tranDate ?? "—"} ${tx.time ?? ""}`.trim();
      const amount = tx.amount?.toLocaleString() ?? "—";
      const desc = tx.description ?? "—";
      console.log(`${date.padEnd(16)}| ${amount.padEnd(14)}| ${desc}`);
    }
  } catch (error) {
    if (error instanceof KhaanError) {
      console.error(`\nKhaan error: ${error.message}`);
      console.error(`  status: ${error.statusCode ?? "n/a"}`);
      console.error(`  endpoint: ${error.endpoint ?? "n/a"}`);
    } else {
      console.error("Unexpected error:", error);
    }
    process.exit(1);
  }
}

main();
