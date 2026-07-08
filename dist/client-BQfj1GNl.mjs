import { a as KhaanNetworkError, i as KhaanMfaError, n as KhaanAuthError, o as KhaanRateLimitError, r as KhaanError, t as KhaanApiError } from "./errors-DHX6vOcB.mjs";
import ky, { isHTTPError, isNetworkError, isTimeoutError } from "ky";
import * as v from "valibot";
//#region src/lib/schemas.ts
const ErrorResponseSchema = v.object({
	message: v.optional(v.string()),
	error: v.optional(v.string()),
	code: v.optional(v.string())
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
	message: v.optional(v.string())
});
const TransactionSchema = v.object({
	tranDate: v.optional(v.string()),
	time: v.optional(v.string()),
	amount: v.optional(v.number()),
	description: v.optional(v.string()),
	balance: v.optional(v.number()),
	relatedAccount: v.optional(v.string()),
	currency: v.optional(v.string()),
	code: v.optional(v.string()),
	refId: v.optional(v.string())
});
const TransactionListSchema = v.array(TransactionSchema);
//#endregion
//#region src/lib/helpers.ts
/** Base64-encode a string (works in browser and Node). */
const base64Encode = (value) => {
	if (typeof btoa === "function") return btoa(value);
	return Buffer.from(value, "utf-8").toString("base64");
};
/**
* Extract a human-readable message from a ky HTTPError.
* ky pre-parses the response body into `error.data` (JSON object or string).
* Khan Bank returns JSON errors with Mongolian messages.
*/
const extractErrorMessage = (error) => {
	const data = error.data;
	if (typeof data === "object" && data !== null) {
		const parsed = v.safeParse(ErrorResponseSchema, data);
		if (parsed.success) return parsed.output.message ?? parsed.output.error ?? parsed.output.code ?? JSON.stringify(data);
		return JSON.stringify(data);
	}
	if (typeof data === "string" && data.length > 0) return data;
	return `Khaan request failed with ${error.response.status}`;
};
/**
* Classify a ky HTTPError into the appropriate typed KhaanError.
* Used in the ky `beforeError` hook so callers get typed errors.
*/
const classifyHttpError = (error) => {
	const status = error.response.status;
	const message = extractErrorMessage(error);
	const opts = {
		statusCode: status,
		endpoint: error.request.url
	};
	if (status === 429) return new KhaanRateLimitError(message, opts);
	if (status === 401 || status === 403) return new KhaanAuthError(message, opts);
	return new KhaanApiError(message, opts);
};
/**
* ky `beforeError` hook that classifies all ky errors into typed KhaanErrors.
* HTTPError → Auth/RateLimit/Api by status. Network/Timeout → KhaanNetworkError.
* Unknown ky errors default to KhaanNetworkError so callers always get a typed error.
*/
const classifyKyError = (error) => {
	if (error instanceof KhaanError) return error;
	if (isHTTPError(error)) return classifyHttpError(error);
	if (isNetworkError(error) || isTimeoutError(error)) return new KhaanNetworkError(`Network error: ${error.message}`, {
		endpoint: "request" in error ? error.request.url : void 0,
		cause: error
	});
	return new KhaanNetworkError(`Network error: ${error.message}`, { cause: error });
};
//#endregion
//#region src/lib/constants.ts
/** Khan Bank API base URLs and endpoint paths. */
const BASE_URL = "https://e.khanbank.com/v3";
const TOKEN_PATH = "cfrm/auth/token";
const TOKEN_URL = `${BASE_URL}/${TOKEN_PATH}`;
//#endregion
//#region src/auth/client.ts
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
var KhaanClient = class {
	config;
	http;
	tokenState = null;
	/** In-flight re-login promise — dedupes concurrent 401s and prevents loops. */
	reLoginPromise = null;
	constructor(config) {
		this.config = config;
		this.http = ky.create({
			baseUrl: `${BASE_URL}/`,
			headers: this.baseHeaders(),
			retry: { limit: 0 },
			hooks: {
				beforeRequest: [({ request }) => {
					if (this.tokenState) request.headers.set("Authorization", `Bearer ${this.tokenState.accessToken}`);
				}],
				afterResponse: [async ({ request, response }) => {
					if (response.status !== 401) return;
					if (request.url.startsWith(TOKEN_URL)) return;
					await this.reLogin();
					return this.http(request);
				}],
				beforeError: [({ error }) => classifyKyError(error)]
			}
		});
	}
	/**
	* High-level login: runs all 3 SOTP steps if needed.
	* If the device is already remembered, completes in one step (no onOtp call).
	* If MFA is required and `onOtp` is provided, dispatches SOTP, calls `onOtp`
	* to get the code, then submits + remembers the device.
	* If MFA is required and `onOtp` is absent, throws `KhaanMfaError`.
	*/
	async login(options) {
		const initial = await this.loginInitial();
		if (initial.status === "logged_in") return { accessToken: initial.accessToken };
		if (!options?.onOtp) throw new KhaanMfaError("MFA required but no onOtp callback provided", { endpoint: TOKEN_URL });
		const { requestId } = initial;
		await this.dispatchOtp(requestId);
		const otp = await options.onOtp(requestId);
		return { accessToken: (await this.submitOtp(requestId, otp)).accessToken };
	}
	/** Step 1: initial login. Returns mfa_required + requestId if MFA needed. */
	async loginInitial() {
		const body = await this.postToken({
			username: this.config.username,
			password: base64Encode(this.config.password),
			grant_type: "password",
			channelId: "I",
			languageId: "003"
		});
		if (body.access_token) {
			this.setTokenState(body);
			return {
				status: "logged_in",
				accessToken: body.access_token
			};
		}
		const requestId = body.unique_id ?? "";
		if (!requestId) throw new KhaanMfaError("MFA required but no unique_id returned", { endpoint: TOKEN_URL });
		return {
			status: "mfa_required",
			requestId
		};
	}
	/** Step 2: dispatch SOTP to the user's registered phone/email. */
	async dispatchOtp(requestId) {
		await this.postToken({
			username: this.config.username,
			password: base64Encode(this.config.password),
			grant_type: "password",
			channelId: "I",
			languageId: "003",
			isPrelogin: "N",
			requestId,
			secondaryMode: "SOTP"
		});
	}
	/** Step 3: submit OTP + rememberDevice. Returns tokens. */
	async submitOtp(requestId, otp) {
		const body = await this.postToken({
			username: this.config.username,
			password: base64Encode(otp),
			grant_type: "password",
			channelId: "I",
			languageId: "003",
			isPrelogin: "N",
			requestId,
			secondaryMode: "",
			rememberDevice: "Y"
		});
		if (!body.access_token) throw new KhaanMfaError(body.message ?? "OTP submission failed — no access_token returned", { endpoint: TOKEN_URL });
		this.setTokenState(body);
		return { accessToken: body.access_token };
	}
	/**
	* Fetch recent transactions (~10 latest) for the configured account.
	* Auth injection and token re-login are handled by ky hooks.
	*/
	async fetchTransactions() {
		this.requireLoggedIn();
		const json = await this.http.get("omni/user/custom/recentTransactions", { searchParams: { account: this.config.accountNumber } }).json();
		return v.parse(TransactionListSchema, json);
	}
	/**
	* Fetch transactions with optional client-side date filtering and account override.
	*
	* The Khan Bank API only exposes a "recent" endpoint (~10 latest) — no
	* server-side date range. `fromDate`/`toDate` filter the results client-side.
	* Useful for reconciliation polling where you only care about a specific window.
	*/
	async getTransactions(options) {
		this.requireLoggedIn();
		const accountNumber = options?.accountNumber ?? this.config.accountNumber;
		const json = await this.http.get("omni/user/custom/recentTransactions", { searchParams: { account: accountNumber } }).json();
		const transactions = v.parse(TransactionListSchema, json);
		if (!options?.fromDate && !options?.toDate) return transactions;
		return filterByDateRange(transactions, options.fromDate, options.toDate);
	}
	requireLoggedIn() {
		if (!this.tokenState) throw new KhaanAuthError("Not logged in — call login() first");
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
	async reLogin() {
		if (this.reLoginPromise) return this.reLoginPromise;
		this.reLoginPromise = (async () => {
			try {
				const json = await ky.post(`${BASE_URL}/${TOKEN_PATH}`, {
					headers: this.baseHeaders(),
					json: {
						username: this.config.username,
						password: base64Encode(this.config.password),
						grant_type: "password",
						channelId: "I",
						languageId: "003"
					},
					retry: { limit: 0 }
				}).json();
				const body = v.parse(LoginResponseSchema, json);
				if (!body.access_token) {
					this.tokenState = null;
					throw new KhaanAuthError("Re-login returned no access_token — MFA may be required");
				}
				this.setTokenState(body);
			} catch (error) {
				this.tokenState = null;
				if (error instanceof KhaanAuthError) throw error;
				if (error instanceof Error) throw classifyKyError(error);
				throw new KhaanNetworkError("Re-login failed", {
					endpoint: TOKEN_URL,
					cause: error
				});
			}
		})();
		try {
			await this.reLoginPromise;
		} finally {
			this.reLoginPromise = null;
		}
	}
	setTokenState(body) {
		if (!body.access_token) throw new KhaanAuthError("Cannot set token state — no access_token in response");
		const expiresIn = Number(body.access_token_expires_in) || 300;
		this.tokenState = {
			accessToken: body.access_token,
			refreshToken: body.refresh_token,
			expiresAt: Date.now() + expiresIn * 1e3
		};
	}
	async postToken(payload) {
		const json = await this.http.post(TOKEN_PATH, { json: payload }).json();
		return v.parse(LoginResponseSchema, json);
	}
	baseHeaders() {
		const headers = {
			"device-id": this.config.deviceId,
			"Accept-Language": "mn-MN",
			secure: "yes"
		};
		if (this.config.userAgent) headers["User-Agent"] = this.config.userAgent;
		return headers;
	}
};
const ONE_DAY_MS = 1440 * 60 * 1e3;
/**
* Filter transactions by date range (inclusive on both ends).
* Throws on unparseable dates so bad input is surfaced, not silently dropped.
*/
function filterByDateRange(transactions, fromDate, toDate) {
	const fromMs = fromDate ? Date.parse(fromDate) : -Infinity;
	const toMs = toDate ? Date.parse(toDate) : Infinity;
	if (fromDate && Number.isNaN(fromMs)) throw new Error(`Invalid fromDate: ${fromDate}`);
	if (toDate && Number.isNaN(toMs)) throw new Error(`Invalid toDate: ${toDate}`);
	const endMs = toMs === Infinity ? Infinity : toMs + ONE_DAY_MS;
	return transactions.filter((tx) => {
		if (!tx.tranDate) return false;
		const txMs = Date.parse(tx.tranDate);
		if (Number.isNaN(txMs)) return false;
		return txMs >= fromMs && txMs < endMs;
	});
}
//#endregion
export { KhaanClient as t };
