# khaan-client

TypeScript SDK for Khan Bank (Khaan) — login with SOTP OTP, fetch transactions, reconcile transfers automatically.

## Install

```bash
pnpm add khaan-client@github:darjss/khaan-client
```

## Quick start

### First-time device setup

Khan Bank requires OTP on first login. Remember your device once so prod logins skip MFA:

```bash
npx khaan-client remember-device
# → Username: your_username
# → Password: ********
# → OTP (from SMS/email): 123456
# → Device remembered. Use this deviceId in prod: a1b2c3d4-...
```

Save the printed deviceId in your env: `KHAAN_DEVICE_ID=a1b2c3d4-...`

### Login + fetch transactions

```ts
import { KhaanClient } from "khaan-client";

const client = new KhaanClient({
  username: process.env.KHAAN_USERNAME!,
  password: process.env.KHAAN_PASSWORD!,
  deviceId: process.env.KHAAN_DEVICE_ID!,
  accountNumber: process.env.KHAAN_ACCOUNT_NUMBER!,
});

// Device is remembered — no OTP needed
await client.login();

const transactions = await client.fetchTransactions();
console.log(transactions);
// [{ tranDate, time, amount, description, balance, relatedAccount }, ...]
```

### Login with OTP (first time or device un-remembered)

```ts
await client.login({
  onOtp: async (requestId) => {
    // OTP arrives via SMS — you read it and return the code
    return await waitForSmsOtp();
  },
});
```

### Reconcile a transfer (poll until matched)

```ts
import { KhaanClient, reconcileTransfer } from "khaan-client";

const client = new KhaanClient({
  /* config */
});

for await (const state of reconcileTransfer(
  client,
  {
    getPayment: async (num) => {
      const p = await db.payments.findByNumber(num);
      if (!p) return { status: "not_found" as const };
      if (p.status === "success") return { status: "already_confirmed" as const };
      return { status: "confirmable" as const, expectedAmount: p.amount };
    },
    onMatched: async (num, match) => {
      await db.payments.confirm(num, match);
      await notify.customer(num, "Payment confirmed");
      return { confirmed: true };
    },
    onAmbiguous: async (num, matches) => {
      await notify.admin(num, `${matches.length} ambiguous — resolve manually`);
    },
    onTimeout: async (num) => {
      await notify.admin(num, "Transfer not found within timeout");
    },
  },
  "PAYABC1234",
)) {
  console.log(`[${state.attempts}] ${state.status}`);
  if (state.matchedTransaction) {
    console.log(`  matched: ${state.matchedTransaction.amount}`);
  }
}
```

### Reconciliation matching only (no polling)

```ts
import { findMatchingKhaanTransfer, isIncoming } from "khaan-client/reconciliation";

const result = findMatchingKhaanTransfer({
  transactions: await client.fetchTransactions(),
  paymentNumber: "PAYABC1234",
  expectedAmount: 125000,
});

if (result.status === "matched") {
  console.log("Found:", result.match);
} else if (result.status === "ambiguous") {
  console.log("Multiple matches:", result.matches);
} else {
  console.log("No match");
}
```

## API

### `KhaanClient`

| Method                      | Description                                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `login({ onOtp? })`         | High-level: runs all 3 SOTP steps if needed. If device is remembered, completes in one step.                      |
| `loginInitial()`            | Step 1: initial login. Returns `{ status: "mfa_required", requestId }` or `{ status: "logged_in", accessToken }`. |
| `dispatchOtp(requestId)`    | Step 2: sends SOTP to phone/email.                                                                                |
| `submitOtp(requestId, otp)` | Step 3: submits OTP + remembers device. Returns `{ accessToken }`.                                                |
| `fetchTransactions()`       | Fetches ~10 recent transactions. Auto-refreshes token if expired.                                                 |

### `reconcileTransfer(client, hooks, paymentNumber, options?)`

Async iterator yielding `TransferReconciliationState` after every poll cycle and on terminal status.

**Hooks:**

- `getPayment(paymentNumber)` — is it still confirmable? what amount?
- `onMatched(paymentNumber, match)` — confirm + notify
- `onAmbiguous?(paymentNumber, matches)` — multiple matches, resolve manually
- `onTimeout?(paymentNumber)` — timed out

**Options:**

- `pollIntervalMs` (default 25000)
- `maxPollMs` (default 300000)
- `signal` — AbortSignal
- `onOtp` — OTP callback if MFA is needed

### Errors

All errors extend `KhaanError` and carry the original Khan Bank message (Mongolian) + `statusCode` + `endpoint`:

- `KhaanAuthError` — wrong credentials, invalid token
- `KhaanMfaError` — MFA-specific failures
- `KhaanApiError` — generic API error
- `KhaanNetworkError` — fetch failed
- `KhaanRateLimitError` — 429

## CLI

```bash
npx khaan-client remember-device [options]

Options:
  -u, --username <user>       Khan Bank username (prompts if omitted)
  -p, --password <pass>       Khan Bank password (prompts if omitted)
  -d, --device-id <uuid>      Device ID to remember (generates if omitted)
  --generate-device-id        Generate a new UUID
  -a, --account-number <num>  Account number
  --user-agent <ua>           Custom User-Agent
  -h, --help                  Show help
```

## Development

```bash
vp install     # install deps
vp check       # format + lint + typecheck
vp test        # run tests
vp pack        # build
```

## License

MIT
