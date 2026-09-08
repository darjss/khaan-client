/** Khan Bank API base URLs and endpoint paths. */

// Retail/internet-banking auth + omni APIs moved off e.khanbank.com onto the
// Apigee edge on :9003. e.khanbank.com/v3/cfrm/auth/token now returns
// Express "Cannot POST" HTML (SPA only).
export const BASE_URL = "https://api.khanbank.com:9003/v3";
export const TOKEN_PATH = "cfrm/auth/token";
export const TOKEN_URL = `${BASE_URL}/${TOKEN_PATH}`;

// Public mobile-app client credentials (client_id:client_secret), base64.
// Required as Authorization: Basic on the token endpoint; Bearer replaces it
// for authenticated omni calls via the beforeRequest hook.
export const APP_BASIC_AUTH =
  "Vm00eHFtV1BaQks3Vm5UYjNRRXJZbjlJZkxoWmF6enI6dElJQkFsU09pVXIwclV5cA==";
