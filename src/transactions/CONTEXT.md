# Transactions

Fetching account statements (recent transactions) from Khan Bank.

## Language

**Transaction**:
A single entry in an account statement. Has a date, time, signed amount, description, running balance, and optional related account.
_Avoid_: Entry, record, movement

**Recent Statement**:
The list of ~10 latest transactions for an account, fetched via the recent/omni endpoint. The only transaction endpoint exposed by the current Khan Bank web API.
_Avoid_: Transaction list, history, ledger

**Incoming Transaction**:
A transaction with a positive amount — money flowing into the account. Direction is inferred from the sign of `amount` since the API doesn't expose amount-type codes.
_Avoid_: Credit, deposit, inbound
