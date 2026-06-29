# Reconciliation

Matching incoming Khan Bank transfers to expected payments, and polling until a match is found or timeout.

## Language

**Payment Number**:
The caller-supplied identifier (e.g. `PAYABC1234`) that a customer includes in their transfer description. Used to match a transaction to an expected payment.
_Avoid_: Order number, reference number, invoice number

**Expected Amount**:
The amount the caller expects to receive for a given payment number. Matched by exact equality against a transaction's amount.
_Avoid_: Target amount, predicted amount

**Match**:
A single incoming transaction whose amount equals the expected amount and whose description contains the payment number.
_Avoid_: Hit, found transfer, confirmed payment

**Ambiguous**:
Two or more transactions match the same payment number + expected amount. The reconciler cannot pick one — caller must resolve manually.
_Avoid_: Duplicate, conflict, unclear

**Poll Cycle**:
One iteration of the reconciler: login (if needed) → fetch transactions → match → report. Repeats at `pollIntervalMs` until matched, ambiguous, timeout, or aborted.
_Avoid_: Tick, round, attempt

**Reconciler Hooks**:
Caller-supplied callbacks that bridge the framework-agnostic reconciler to the caller's app: `getPayment` (is it still confirmable? what amount?), `onMatched` (confirm + notify), `onAmbiguous`, `onTimeout`.
_Avoid_: Callbacks, integrations, adapters
