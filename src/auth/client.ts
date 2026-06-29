import * as v from "valibot";
import {
  KhaanApiError,
  KhaanAuthError,
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

const TOKEN_URL = "https://e.khanbank.com/v3/cfrm/auth/token";
const BASE_URL = "https://e.khanbank.com/v3";

// --- Helpers (internal) -----------------------------------------------------

const base64Encode = (value: string): string => {
  if (typeof btoa === "function") return btoa(value);
  // Node.js fallback
  return Buffer.from(value, "utf-8").toString("base64");
};

/**
 * Read the error message from a Response body.
 * Khan Bank returns JSON errors with Mongolian messages.
 */
const readErrorMessage = async (response: Response): Promise<string> => {
  const body = await response.clone().text();
  try {
    const parsed = v.parse(ErrorResponseSchema, JSON.parse(body));
    return parsed.message ?? parsed.error ?? parsed.code ?? body;
  } catch {
    return body || `Khaan request failed with ${response.status}`;
  }
};

const classifyError = async (response: Response, endpoint: string): Promise<never> => {
  const message = await readErrorMessage(response);
  const opts = { statusCode: response.status, endpoint };

  if (response.status === 429) {
    throw new KhaanRateLimitError(message, opts);
  }
  if (response.status === 401 || response.status === 403) {
    throw new KhaanAuthError(message, opts);
  }
  throw new KhaanApiError(message, opts);
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
 * header construction, error parsing, valibot response validation.
 */
export class KhaanClient {
  private readonly config: KhaanClientConfig;
  private tokenState: TokenState | null = null;

  constructor(config: KhaanClientConfig) {
    this.config = config;
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
   * Auto-refreshes the token if it's expired or about to expire.
   */
  async fetchTransactions(): Promise<KhaanTransaction[]> {
    const accessToken = await this.getValidAccessToken();
    const url = `${BASE_URL}/account-omni/statement/${this.config.accountNumber}/recent/omni`;

    let response = await fetch(url, {
      method: "GET",
      headers: this.authHeaders(accessToken),
    });

    // If 401, try refreshing the token once and retry
    if (response.status === 401 && this.tokenState?.refreshToken) {
      await this.refreshToken();
      response = await fetch(url, {
        method: "GET",
        headers: this.authHeaders(this.tokenState!.accessToken),
      });
    }

    if (!response.ok) {
      await classifyError(response, url);
    }

    const json = await response.json();
    return v.parse(TransactionListSchema, json);
  }

  // --- Internal: token management ---

  /**
   * Returns a valid access token, refreshing if needed.
   * Called internally before any authenticated request.
   */
  private async getValidAccessToken(): Promise<string> {
    if (!this.tokenState) {
      throw new KhaanAuthError("Not logged in — call login() first");
    }

    // Refresh if token expires within the next 30 seconds
    const now = Date.now();
    if (this.tokenState.expiresAt - now < 30_000) {
      await this.refreshToken();
    }

    return this.tokenState.accessToken;
  }

  /** Refresh the access token using the refresh_token grant. */
  private async refreshToken(): Promise<void> {
    if (!this.tokenState?.refreshToken) {
      throw new KhaanAuthError("No refresh token available — re-login required");
    }

    const url = `${TOKEN_URL}?grant_type=refresh_token&refresh_token=${this.tokenState.refreshToken}`;
    const response = await fetch(url, {
      method: "POST",
      headers: this.baseHeaders(),
      body: "{}",
    });

    if (!response.ok) {
      // Refresh failed — clear token state, caller must re-login
      this.tokenState = null;
      const message = await readErrorMessage(response);
      throw new KhaanAuthError(`Token refresh failed: ${message}`, {
        statusCode: response.status,
        endpoint: TOKEN_URL,
      });
    }

    const json = await response.json();
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
   */
  private async postToken(
    payload: Record<string, string>,
  ): Promise<v.InferOutput<typeof LoginResponseSchema>> {
    let response: Response;
    try {
      response = await fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          ...this.baseHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new KhaanNetworkError(
        `Network error during login: ${error instanceof Error ? error.message : String(error)}`,
        { endpoint: TOKEN_URL, cause: error },
      );
    }

    if (!response.ok) {
      await classifyError(response, TOKEN_URL);
    }

    const json = await response.json();
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

  private authHeaders(accessToken: string): Record<string, string> {
    return {
      ...this.baseHeaders(),
      Authorization: `Bearer ${accessToken}`,
    };
  }
}
