import ky, { type KyInstance, HTTPError, isHTTPError, isNetworkError } from "ky";
import * as v from "valibot";
import {
  KhaanApiError,
  KhaanAuthError,
  KhaanError,
  KhaanMfaError,
  KhaanNetworkError,
  KhaanRateLimitError,
} from "../errors.ts";

// --- Types (public) ---------------------------------------------------------

export type KhaanClientConfig = {
  username: string;
  password: string;
  deviceId: string;
  userAgent?: string;
  accountNumber: string;
  branchCode?: string;
};

export type KhaanTransaction = {
  tranDate?: string;
  time?: string;
  amount?: number;
  description?: string;
  balance?: number;
  relatedAccount?: string;
};

export type KhaanLoginResult =
  | { status: "logged_in"; accessToken: string }
  | { status: "mfa_required"; requestId: string };

// --- Schemas (internal, not exported) ---------------------------------------

const ErrorResponseSchema = v.object({
  message: v.optional(v.string()),
  error: v.optional(v.string()),
  code: v.optional(v.string()),
});

const LoginResponseSchema = v.object({
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

const TransactionSchema = v.object({
  tranDate: v.optional(v.string()),
  time: v.optional(v.string()),
  amount: v.optional(v.number()),
  description: v.optional(v.string()),
  balance: v.optional(v.number()),
  relatedAccount: v.optional(v.string()),
});

const TransactionListSchema = v.array(TransactionSchema);

// --- Constants --------------------------------------------------------------

const BASE_URL = "https://e.khanbank.com/v3";
const TOKEN_PATH = "cfrm/auth/token";
const TOKEN_URL = `${BASE_URL}/${TOKEN_PATH}`;

// --- Helpers (internal) -----------------------------------------------------

const base64Encode = (value: string): string => {
  if (typeof btoa === "function") return btoa(value);
  return Buffer.from(value, "utf-8").toString("base64");
};

/**
 * Extract a human-readable message from a ky HTTPError.
 * ky pre-parses the response body into `error.data` (JSON object or string).
 * Khan Bank returns JSON errors with Mongolian messages.
 */
const extractErrorMessage = (error: HTTPError): string => {
  const data = error.data;
  if (typeof data === "object" && data !== null) {
    const parsed = v.safeParse(ErrorResponseSchema, data);
    if (parsed.success) {
      return (
        parsed.output.message ?? parsed.output.error ?? parsed.output.code ?? JSON.stringify(data)
      );
    }
    return JSON.stringify(data);
  }
  if (typeof data === "string" && data.length > 0) return data;
  return `Khaan request failed with ${error.response.status}`;
};

/**
 * Classify a ky HTTPError into the appropriate typed KhaanError.
 * Used in the `beforeError` hook so callers get typed errors.
 */
const classifyHttpError = (error: HTTPError): KhaanError => {
  const status = error.response.status;
  const message = extractErrorMessage(error);
  const endpoint = error.request.url;
  const opts = { statusCode: status, endpoint };

  if (status === 429) return new KhaanRateLimitError(message, opts);
  if (status === 401 || status === 403) return new KhaanAuthError(message, opts);
  return new KhaanApiError(message, opts);
};

// --- Token cache (internal) -------------------------------------------------

type TokenState = {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms when the access token expires. */
  expiresAt: number;
};

// --- Client -----------------------------------------------------------------

/**
 * Deep module: Khan Bank API client.
 *
 * Interface: `login()`, `loginInitial()`, `dispatchOtp()`, `submitOtp()`, `fetchTransactions()`.
 * Implementation: 3-step SOTP flow, base64 encoding, token caching + auto-refresh,
 * ky hooks for auth injection + 401-retry + error classification, valibot validation.
 */
export class KhaanClient {
  private readonly config: KhaanClientConfig;
  private readonly http: KyInstance;
  private tokenState: TokenState | null = null;
  /** Guards against infinite refresh loops in the afterResponse hook. */
  private refreshing = false;

  constructor(config: KhaanClientConfig) {
    this.config = config;

    this.http = ky.create({
      baseUrl: `${BASE_URL}/`,
      headers: this.baseHeaders(),
      // No retries — banking API should fail-fast, not duplicate operations
      retry: { limit: 0 },
      hooks: {
        // Inject auth token before every request (if we have one)
        beforeRequest: [
          ({ request }) => {
            if (this.tokenState) {
              request.headers.set("Authorization", `Bearer ${this.tokenState.accessToken}`);
            }
          },
        ],
        // On 401 for authenticated requests: refresh token and retry once
        afterResponse: [
          async ({ request, response }) => {
            // Only handle 401 on authenticated, non-token requests
            if (response.status !== 401) return;
            if (request.url.startsWith(TOKEN_URL)) return;
            if (!this.tokenState?.refreshToken) return;
            if (this.refreshing) return;

            try {
              this.refreshing = true;
              await this.refreshToken();
              // Retry the original request with the new token
              request.headers.set("Authorization", `Bearer ${this.tokenState.accessToken}`);
              return ky(request);
            } finally {
              this.refreshing = false;
            }
          },
        ],
        // Classify ky errors into typed KhaanErrors before they reach the caller
        beforeError: [
          ({ error }) => {
            if (isHTTPError(error)) return classifyHttpError(error);
            if (isNetworkError(error)) {
              return new KhaanNetworkError(`Network error: ${error.message}`, {
                endpoint: error.request.url,
                cause: error,
              });
            }
            return error;
          },
        ],
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

    // MFA required
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
    // Step 2 returns a response but without access_token — we just need the
    // side effect (SMS/email sent). If it fails, postToken throws.
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
   * Fetch recent transactions (~10 latest).
   * Auto-refreshes the token if it's expired or about to expire (proactive),
   * and again reactively on 401 via the ky afterResponse hook.
   */
  async fetchTransactions(): Promise<KhaanTransaction[]> {
    this.requireLoggedIn();
    await this.ensureFreshToken();

    const json = await this.http
      .get(`account-omni/statement/${this.config.accountNumber}/recent/omni`)
      .json();

    return v.parse(TransactionListSchema, json);
  }

  // --- Internal: token management ---

  private requireLoggedIn(): void {
    if (!this.tokenState) {
      throw new KhaanAuthError("Not logged in — call login() first");
    }
  }

  /**
   * Proactively refresh if the token expires within the next 30 seconds.
   * The afterResponse hook handles reactive refresh on 401.
   */
  private async ensureFreshToken(): Promise<void> {
    if (!this.tokenState) return;
    if (this.tokenState.expiresAt - Date.now() < 30_000) {
      await this.refreshToken();
    }
  }

  /** Refresh the access token using the refresh_token grant. */
  private async refreshToken(): Promise<void> {
    if (!this.tokenState?.refreshToken) {
      throw new KhaanAuthError("No refresh token available — re-login required");
    }

    // Use a bare ky call (not this.http) to bypass hooks — the refresh
    // endpoint should not trigger auth injection or 401-retry logic
    const json = await ky
      .post(`${BASE_URL}/${TOKEN_PATH}`, {
        searchParams: {
          grant_type: "refresh_token",
          refresh_token: this.tokenState.refreshToken,
        },
        headers: this.baseHeaders(),
        body: "{}",
        retry: { limit: 0 },
      })
      .json()
      .catch((error: unknown) => {
        this.tokenState = null;
        if (isHTTPError(error)) {
          throw new KhaanAuthError(`Token refresh failed: ${extractErrorMessage(error)}`, {
            statusCode: error.response.status,
            endpoint: TOKEN_URL,
          });
        }
        throw new KhaanNetworkError("Token refresh network error", {
          endpoint: TOKEN_URL,
          cause: error,
        });
      });

    const body = v.parse(LoginResponseSchema, json);
    if (!body.access_token) {
      this.tokenState = null;
      throw new KhaanAuthError("Token refresh returned no access_token");
    }
    this.setTokenState(body);
  }

  private setTokenState(body: v.InferOutput<typeof LoginResponseSchema>): void {
    const expiresIn = Number(body.access_token_expires_in) || 300;
    this.tokenState = {
      accessToken: body.access_token!,
      refreshToken: body.refresh_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }

  // --- Internal: HTTP ---

  /**
   * POST to the token endpoint with a JSON body.
   * Used by all 3 login steps (different payloads).
   * Errors are classified by the beforeError hook.
   */
  private async postToken(
    payload: Record<string, string>,
  ): Promise<v.InferOutput<typeof LoginResponseSchema>> {
    const json = await this.http.post(TOKEN_PATH, { json: payload }).json();
    return v.parse(LoginResponseSchema, json);
  }

  // --- Internal: headers ---

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
