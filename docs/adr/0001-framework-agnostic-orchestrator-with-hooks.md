# Framework-agnostic orchestrator with caller-supplied hooks

The reconciliation orchestrator is framework-agnostic — it runs in Node, a Cloudflare Durable Object, or any JS runtime. The app-coupled bits (payment lookup, confirmation, notification) are supplied by the caller as hooks (`getPayment`, `onMatched`, `onAmbiguous`, `onTimeout`), not imported from the caller's app. This keeps the lib dependency-free of any specific framework or app's data layer, while still providing the full poll loop + login + fetch + match logic.
