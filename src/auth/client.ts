import ky, { type KyInstance } from "ky";
import * as v from "valibot";
import { KhaanAuthError, KhaanMfaError, KhaanNetworkError } from "../errors.ts";
import { classifyKyError, base64Encode } from "../lib/helpers.ts";
import {
  LoginResponseSchema,
  TransactionListSchema,
  type LoginResponseBody,
} from "../lib/schemas.ts";
import { BASE_URL, TOKEN_PATH, TOKEN_URL } from "../lib/constants.ts";
import type { KhaanClientConfig, KhaanLoginResult, TokenState } from "./types.ts";
import type { GetTransactionsOptions, KhaanTransaction } from "../transactions/types.ts";

// --- Client -----------------------------------------------------------------

/**
 * Deep module: Khan Bank API client.
 *
 * Interface: `login()`, `loginInitial()`, `dispatchOtp()`, `submitOtp()`,
 * `fetchTransactions()`, `getTransactions()`.
 * Implementation: 3-step SOTP flow, base64 encoding, token caching + reactive re-login,
 * ky hooks for auth injection + 401-retry + error classification, valibot validation.
 *
 * NOTE: The Khan Bank API returns a `refresh_token` in login responses, but the
 * Apigee gateway's refresh endpoint is non-functional (returns `invalid_request`
 * for all attempts). Token renewal is done via re-login using the remembered
 * device (set via `rememberDevice: "Y"` in step 3 of SOTP), which completes in
 * a single step without OTP.
 *
 * Re-login is REACTIVE only — triggered by a 401 response, not proactively
 * before token expiry. This minimizes password-based logins to avoid rate
 * limiting (429) and suspicious-activity flags. A token that lasts 5 minutes
 * with 25-second polling means at most 1 re-login per 5 minutes (~12/hour).
 */
export class KhaanClient {
  private readonly config: KhaanClientConfig;
  private readonly http: KyInstance;
  private tokenState: TokenState | null = null;
  /** In-flight re-login promise — dedupes concurrent 401s and prevents loops. */
  private reLoginPromise: Promise<void> | null = null;

  constructor(config: KhaanClientConfig) {
    this.config = config;

    this.http = ky.create({
      baseUrl: `${BASE_URL}/`,
      headers: this.baseHeaders(),
      retry: { limit: 0 },
      hooks: {
        // Inject auth token before every authenticated request.
        // No proactive refresh — re-login is reactive only (on 401) to minimize
        // password-based logins and avoid rate limiting / suspicious-activity flags.
        beforeRequest: [
          ({ request }) => {
            if (this.tokenState) {
              request.headers.set("Authorization", `Bearer ${this.tokenState.accessToken}`);
            }
          },
        ],
        // On 401 for authenticated requests: re-login and retry once.
        // Uses this.http(request) so the retried request respects retry:0 + hooks.
        afterResponse: [
          async ({ request, response }) => {
            if (response.status !== 401) return;
            // Don't retry 401 on the token endpoint itself — bad credentials, not expired token
            if (request.url.startsWith(TOKEN_URL)) return;

            await this.reLogin();
            // beforeRequest will inject the new token on the retried request
            return this.http(request);
          },
        ],
        // Classify ky errors into typed KhaanErrors before they reach the caller
        beforeError: [({ error }) => classifyKyError(error)],
      },
    });
  }

  // --- High-level login ---

  /**
   * High-level login: runs all 3 SOTP steps if needed.
   * If the device is already remembered, completes in one step (no onOtp call).
   * If MFA is required and `onOtp` is provided, dispatches SOTP, calls `onOtp`
   * to get the code, then submits + remembers the device.
   * If MFA is required and `onOtp` is absent, throws `KhaanMfaError`.
   */
  async login(options?: {
    onOtp?: (requestId: string) => Promise<string>;
  }): Promise<{ accessToken: string }> {
    const initial = await this.loginInitial();

    if (initial.status === "logged_in") {
      return { accessToken: initial.accessToken };
    }

    if (!options?.onOtp) {
      throw new KhaanMfaError("MFA required but no onOtp callback provided", {
        endpoint: TOKEN_URL,
      });
    }

    const { requestId } = initial;
    await this.dispatchOtp(requestId);
    const otp = await options.onOtp(requestId);
    const result = await this.submitOtp(requestId, otp);
    return { accessToken: result.accessToken };
  }

  // --- Low-level 3-step SOTP ---

  /** Step 1: initial login. Returns mfa_required + requestId if MFA needed. */
  async loginInitial(): Promise<KhaanLoginResult> {
    const body = await this.postToken({
      username: this.config.username,
      password: base64Encode(this.config.password),
      grant_type: "password",
      channelId: "I",
      languageId: "003",
    });

    if (body.access_token) {
      this.setTokenState(body);
      return { status: "logged_in", accessToken: body.access_token };
    }

    const requestId = body.unique_id ?? "";
    if (!requestId) {
      throw new KhaanMfaError("MFA required but no unique_id returned", {
        endpoint: TOKEN_URL,
      });
    }
    return { status: "mfa_required", requestId };
  }

  /** Step 2: dispatch SOTP to the user's registered phone/email. */
  async dispatchOtp(requestId: string): Promise<void> {
    await this.postToken({
      username: this.config.username,
      password: base64Encode(this.config.password),
      grant_type: "password",
      channelId: "I",
      languageId: "003",
      isPrelogin: "N",
      requestId,
      secondaryMode: "SOTP",
    });
  }

  /** Step 3: submit OTP + rememberDevice. Returns tokens. */
  async submitOtp(requestId: string, otp: string): Promise<{ accessToken: string }> {
    const body = await this.postToken({
      username: this.config.username,
      password: base64Encode(otp),
      grant_type: "password",
      channelId: "I",
      languageId: "003",
      isPrelogin: "N",
      requestId,
      secondaryMode: "",
      rememberDevice: "Y",
    });

    if (!body.access_token) {
      throw new KhaanMfaError(body.message ?? "OTP submission failed — no access_token returned", {
        endpoint: TOKEN_URL,
      });
    }

    this.setTokenState(body);
    return { accessToken: body.access_token };
  }

  // --- Transactions ---

  /**
   * Fetch recent transactions (~10 latest) for the configured account.
   * Auth injection and token re-login are handled by ky hooks.
   */
  async fetchTransactions(): Promise<KhaanTransaction[]> {
    this.requireLoggedIn();
    const json = await this.http
      .get("omni/user/custom/recentTransactions", {
        searchParams: { account: this.config.accountNumber },
      })
      .json();
    return v.parse(TransactionListSchema, json);
  }

  /**
   * Fetch transactions with optional client-side date filtering and account override.
   *
   * The Khan Bank API only exposes a "recent" endpoint (~10 latest) — no
   * server-side date range. `fromDate`/`toDate` filter the results client-side.
   * Useful for reconciliation polling where you only care about a specific window.
   */
  async getTransactions(options?: GetTransactionsOptions): Promise<KhaanTransaction[]> {
    this.requireLoggedIn();

    const accountNumber = options?.accountNumber ?? this.config.accountNumber;
    const json = await this.http
      .get("omni/user/custom/recentTransactions", {
        searchParams: { account: accountNumber },
      })
      .json();
    const transactions = v.parse(TransactionListSchema, json);

    if (!options?.fromDate && !options?.toDate) return transactions;

    return filterByDateRange(transactions, options.fromDate, options.toDate);
  }

  // --- Internal: token management ---

  private requireLoggedIn(): void {
    if (!this.tokenState) {
      throw new KhaanAuthError("Not logged in — call login() first");
    }
  }

  /**
   * Re-login using stored credentials. The Khan Bank API's refresh_token endpoint
   * is non-functional, so token renewal is done via a full re-login. Since the
   * device is remembered (rememberDevice: "Y" set during initial SOTP), this
   * completes in a single step without OTP.
   *
   * Dedupes concurrent calls via reLoginPromise — all 401s in the same window
   * share one re-login. Uses bare ky (not this.http) to bypass hooks — the
   * token endpoint should not trigger auth injection or 401-retry logic.
   */
  private async reLogin(): Promise<void> {
    if (this.reLoginPromise) return this.reLoginPromise;

    this.reLoginPromise = (async () => {
      try {
        const json = await ky
          .post(`${BASE_URL}/${TOKEN_PATH}`, {
            headers: this.baseHeaders(),
            json: {
              username: this.config.username,
              password: base64Encode(this.config.password),
              grant_type: "password",
              channelId: "I",
              languageId: "003",
            },
            retry: { limit: 0 },
          })
          .json();

        const body = v.parse(LoginResponseSchema, json);
        if (!body.access_token) {
          this.tokenState = null;
          throw new KhaanAuthError("Re-login returned no access_token — MFA may be required");
        }
        this.setTokenState(body);
      } catch (error) {
        this.tokenState = null;
        if (error instanceof KhaanAuthError) throw error;
        if (error instanceof Error) {
          throw classifyKyError(error);
        }
        throw new KhaanNetworkError("Re-login failed", { endpoint: TOKEN_URL, cause: error });
      }
    })();

    try {
      await this.reLoginPromise;
    } finally {
      this.reLoginPromise = null;
    }
  }

  private setTokenState(body: LoginResponseBody): void {
    if (!body.access_token) {
      throw new KhaanAuthError("Cannot set token state — no access_token in response");
    }
    const expiresIn = Number(body.access_token_expires_in) || 300;
    this.tokenState = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  // --- Internal: HTTP ---

  private async postToken(payload: Record<string, string>): Promise<LoginResponseBody> {
    const json = await this.http.post(TOKEN_PATH, { json: payload }).json();
    return v.parse(LoginResponseSchema, json);
  }

  private baseHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "device-id": this.config.deviceId,
      "Accept-Language": "mn-MN",
      secure: "yes",
    };
    if (this.config.userAgent) {
      headers["User-Agent"] = this.config.userAgent;
    }
    return headers;
  }
}

// --- Internal: date filtering ---

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Filter transactions by date range (inclusive on both ends).
 * Throws on unparseable dates so bad input is surfaced, not silently dropped.
 */
function filterByDateRange(
  transactions: KhaanTransaction[],
  fromDate?: string,
  toDate?: string,
): KhaanTransaction[] {
  const fromMs = fromDate ? Date.parse(fromDate) : -Infinity;
  const toMs = toDate ? Date.parse(toDate) : Infinity;

  if (fromDate && Number.isNaN(fromMs)) {
    throw new Error(`Invalid fromDate: ${fromDate}`);
  }
  if (toDate && Number.isNaN(toMs)) {
    throw new Error(`Invalid toDate: ${toDate}`);
  }

  // toDate is inclusive — extend to end of day
  const endMs = toMs === Infinity ? Infinity : toMs + ONE_DAY_MS;

  return transactions.filter((tx) => {
    if (!tx.tranDate) return false;
    const txMs = Date.parse(tx.tranDate);
    if (Number.isNaN(txMs)) return false;
    return txMs >= fromMs && txMs < endMs;
  });
}
