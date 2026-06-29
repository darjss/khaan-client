# Context Map

## Contexts

- [Auth](./src/auth/CONTEXT.md) — Khan Bank login, SOTP OTP flow, token refresh
- [Transactions](./src/transactions/CONTEXT.md) — fetching account statements (recent transactions)
- [Reconciliation](./src/reconciliation/CONTEXT.md) — matching incoming transfers to expected payments, polling orchestrator

## Relationships

- **Auth → Transactions**: Transactions require an access token from Auth
- **Auth → Reconciliation**: Reconciliation orchestrator uses Auth to login and maintain a token across poll cycles
- **Transactions → Reconciliation**: Reconciliation fetches transactions to match against expected payments
