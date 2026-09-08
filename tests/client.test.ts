import { expect, test, describe, vi, beforeEach, afterEach } from "vite-plus/test";
import { KhaanClient } from "../src/auth/client.ts";
import {
  KhaanAuthError,
  KhaanMfaError,
  KhaanApiError,
  KhaanRateLimitError,
} from "../src/errors.ts";

// --- Test helpers ---

const baseConfig = {
  username: "testuser",
  password: "testpass",
  deviceId: "test-device-id",
  accountNumber: "1234567890",
};

const mockResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
};

/**
 * Captured fetch call — stores URL, method, headers, and body text so tests
 * can assert on them without fighting Request stream consumption (ky passes
 * a Request object whose body stream can't be cloned after disturbance).
 */
type CapturedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
};

const capturedCalls: CapturedCall[] = [];

/** Queue of responses to return from the mocked fetch. */
let responseQueue: Response[] = [];

const mockFetchFn = async (input: unknown, init?: RequestInit): Promise<Response> => {
  let url: string;
  let method: string;
  let headers: Record<string, string>;
  let body: string;

  if (input instanceof Request) {
    url = input.url;
    method = input.method;
    headers = {};
    input.headers.forEach((v: string, k: string) => {
      headers[k] = v;
    });
    body = await input.text();
  } else {
    url = String(input);
    method = init?.method ?? "GET";
    headers = (init?.headers ?? {}) as Record<string, string>;
    body = (init?.body ?? "") as string;
  }

  capturedCalls.push({ url, method, headers, body });
  return responseQueue.shift() ?? new Response("{}", { status: 200 });
};

/** Queue responses for the next client operation. */
const queueResponses = (...responses: Response[]): void => {
  responseQueue.push(...responses);
};

/** Parsed JSON body of the Nth captured fetch call. */
const getCallBody = (index: number): Record<string, string> => {
  return JSON.parse(capturedCalls[index]?.body || "{}");
};

/** Headers of the Nth captured fetch call (lowercase keys). */
const getCallHeaders = (index: number): Record<string, string> => {
  return capturedCalls[index]?.headers ?? {};
};

/** URL of the Nth captured fetch call. */
const getCallUrl = (index: number): string => {
  return capturedCalls[index]?.url ?? "";
};

/** HTTP method of the Nth captured fetch call. */
const getCallMethod = (index: number): string => {
  return capturedCalls[index]?.method ?? "GET";
};

const loginSuccessBody = {
  access_token: "test-access-token",
  access_token_expires_in: "300",
  refresh_token: "test-refresh-token",
  refresh_token_status: "approved",
  refresh_token_expires_in: "86400",
  display_name: "Test User",
  primary_account_id: "1234567890",
};

const mfaRequiredBody = {
  unique_id: "test-request-id",
  message: "MFA required",
};

const transactionList = [
  {
    tranDate: "2026-06-28T00:00:00Z",
    time: "18:30",
    amount: 125000,
    description: "PAYABC1234",
    balance: 21167.84,
    relatedAccount: "9876543210",
  },
];

// --- Tests ---

describe("KhaanClient", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(mockFetchFn) as typeof fetch;
    capturedCalls.length = 0;
    responseQueue.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("loginInitial — returns logged_in when device is remembered", async () => {
    queueResponses(mockResponse(loginSuccessBody));

    const client = new KhaanClient(baseConfig);
    const result = await client.loginInitial();

    expect(result.status).toBe("logged_in");
    if (result.status === "logged_in") {
      expect(result.accessToken).toBe("test-access-token");
    }

    const url = new URL(getCallUrl(0));
    expect(url.origin + url.pathname).toBe("https://api.khanbank.com:9003/v3/cfrm/auth/token");
    expect(url.searchParams.get("grant_type")).toBe("password");
    expect(url.searchParams.get("username")).toBe("testuser");
    expect(url.searchParams.get("password")).toBe(btoa("testpass"));
    expect(url.searchParams.get("channelId")).toBe("I");
    expect(getCallMethod(0)).toBe("POST");
    expect(getCallHeaders(0)["authorization"]).toMatch(/^Basic /);
    const body = getCallBody(0);
    expect(body.username).toBe("testuser");
    expect(body.grant_type).toBe("password");
    expect(body.channelId).toBe("I");
    expect(body.languageId).toBe("003");
    expect(body.password).toBe(btoa("testpass"));
  });

  test("loginInitial — returns mfa_required with requestId", async () => {
    queueResponses(mockResponse(mfaRequiredBody));

    const client = new KhaanClient(baseConfig);
    const result = await client.loginInitial();

    expect(result.status).toBe("mfa_required");
    if (result.status === "mfa_required") {
      expect(result.requestId).toBe("test-request-id");
    }
  });

  test("login — high-level with onOtp runs all 3 steps", async () => {
    queueResponses(
      mockResponse(mfaRequiredBody),
      mockResponse({ message: "OTP sent" }),
      mockResponse(loginSuccessBody),
    );

    const client = new KhaanClient(baseConfig);
    const onOtp = vi.fn().mockResolvedValue("123456");
    const result = await client.login({ onOtp });

    expect(result.accessToken).toBe("test-access-token");
    expect(onOtp).toHaveBeenCalledWith("test-request-id");

    // Step 2: SOTP dispatch
    const step2Body = getCallBody(1);
    expect(step2Body.isPrelogin).toBe("N");
    expect(step2Body.requestId).toBe("test-request-id");
    expect(step2Body.secondaryMode).toBe("SOTP");

    // Step 3: OTP submit + rememberDevice
    const step3Body = getCallBody(2);
    expect(step3Body.isPrelogin).toBe("N");
    expect(step3Body.requestId).toBe("test-request-id");
    expect(step3Body.secondaryMode).toBe("");
    expect(step3Body.rememberDevice).toBe("Y");
    expect(step3Body.password).toBe(btoa("123456"));
  });

  test("login — high-level without onOtp throws KhaanMfaError when MFA required", async () => {
    queueResponses(mockResponse(mfaRequiredBody));

    const client = new KhaanClient(baseConfig);
    await expect(client.login()).rejects.toThrow(KhaanMfaError);
  });

  test("login — completes in one step when device is remembered", async () => {
    queueResponses(mockResponse(loginSuccessBody));

    const client = new KhaanClient(baseConfig);
    const onOtp = vi.fn();
    const result = await client.login({ onOtp });

    expect(result.accessToken).toBe("test-access-token");
    expect(onOtp).not.toHaveBeenCalled();
    expect(capturedCalls).toHaveLength(1);
  });

  test("dispatchOtp — sends SOTP dispatch request", async () => {
    queueResponses(mockResponse({ message: "OTP sent" }));

    const client = new KhaanClient(baseConfig);
    await client.dispatchOtp("test-request-id");

    expect(capturedCalls).toHaveLength(1);
    const body = getCallBody(0);
    expect(body.secondaryMode).toBe("SOTP");
    expect(body.requestId).toBe("test-request-id");
  });

  test("submitOtp — submits OTP + rememberDevice, returns accessToken", async () => {
    queueResponses(mockResponse(loginSuccessBody));

    const client = new KhaanClient(baseConfig);
    const result = await client.submitOtp("test-request-id", "123456");

    expect(result.accessToken).toBe("test-access-token");
    const body = getCallBody(0);
    expect(body.rememberDevice).toBe("Y");
    expect(body.password).toBe(btoa("123456"));
  });

  test("submitOtp — throws KhaanMfaError when no access_token returned", async () => {
    queueResponses(mockResponse({ message: "Invalid OTP" }, 200));

    const client = new KhaanClient(baseConfig);
    await expect(client.submitOtp("test-request-id", "wrong")).rejects.toThrow(KhaanMfaError);
  });

  test("fetchTransactions — returns parsed transaction list", async () => {
    queueResponses(mockResponse(loginSuccessBody), mockResponse(transactionList));

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    const transactions = await client.fetchTransactions();

    expect(transactions).toHaveLength(1);
    expect(transactions[0].amount).toBe(125000);
    expect(transactions[0].description).toBe("PAYABC1234");
  });

  test("fetchTransactions — throws KhaanAuthError when not logged in", async () => {
    const client = new KhaanClient(baseConfig);
    await expect(client.fetchTransactions()).rejects.toThrow(KhaanAuthError);
  });

  test("fetchTransactions — throws KhaanApiError on non-ok response", async () => {
    queueResponses(mockResponse(loginSuccessBody), mockResponse({ message: "Server error" }, 500));

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    await expect(client.fetchTransactions()).rejects.toThrow(KhaanApiError);
  });

  test("fetchTransactions — throws KhaanRateLimitError on 429", async () => {
    queueResponses(
      mockResponse(loginSuccessBody),
      mockResponse({ message: "Too many requests" }, 429),
    );

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    await expect(client.fetchTransactions()).rejects.toThrow(KhaanRateLimitError);
  });

  test("loginInitial — throws KhaanAuthError on 401", async () => {
    queueResponses(mockResponse({ message: "Хэрэглэгчийн нэр эсвэл нууц үг буруу" }, 401));

    const client = new KhaanClient(baseConfig);
    await expect(client.loginInitial()).rejects.toThrow(KhaanAuthError);
  });

  test("loginInitial — throws KhaanApiError on 500", async () => {
    queueResponses(mockResponse({ message: "Серверийн алдаа" }, 500));

    const client = new KhaanClient(baseConfig);
    await expect(client.loginInitial()).rejects.toThrow(KhaanApiError);
  });

  test("headers — includes device-id, Accept-Language, secure", async () => {
    queueResponses(mockResponse(loginSuccessBody));

    const client = new KhaanClient({
      ...baseConfig,
      userAgent: "TestAgent/1.0",
    });
    await client.loginInitial();

    const headers = getCallHeaders(0);
    // ky/Headers normalizes header names to lowercase
    expect(headers["device-id"]).toBe("test-device-id");
    expect(headers["accept-language"]).toBe("mn-MN");
    expect(headers["secure"]).toBe("yes");
    expect(headers["user-agent"]).toBe("TestAgent/1.0");
  });

  // --- getTransactions ---

  const multiDateTransactions = [
    { tranDate: "2026-06-01T00:00:00Z", amount: 1000, description: "June 1" },
    { tranDate: "2026-06-15T00:00:00Z", amount: 2000, description: "June 15" },
    { tranDate: "2026-06-28T00:00:00Z", amount: 3000, description: "June 28" },
    { tranDate: "2026-07-01T00:00:00Z", amount: 4000, description: "July 1" },
  ];

  test("getTransactions — returns all when no filter", async () => {
    queueResponses(mockResponse(loginSuccessBody), mockResponse(multiDateTransactions));

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    const transactions = await client.getTransactions();

    expect(transactions).toHaveLength(4);
  });

  test("getTransactions — filters by fromDate", async () => {
    queueResponses(mockResponse(loginSuccessBody), mockResponse(multiDateTransactions));

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    const transactions = await client.getTransactions({ fromDate: "2026-06-15" });

    expect(transactions).toHaveLength(3);
    expect(transactions[0].description).toBe("June 15");
  });

  test("getTransactions — filters by toDate", async () => {
    queueResponses(mockResponse(loginSuccessBody), mockResponse(multiDateTransactions));

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    const transactions = await client.getTransactions({ toDate: "2026-06-15" });

    expect(transactions).toHaveLength(2);
    expect(transactions[1].description).toBe("June 15");
  });

  test("getTransactions — filters by date range", async () => {
    queueResponses(mockResponse(loginSuccessBody), mockResponse(multiDateTransactions));

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    const transactions = await client.getTransactions({
      fromDate: "2026-06-10",
      toDate: "2026-06-20",
    });

    expect(transactions).toHaveLength(1);
    expect(transactions[0].description).toBe("June 15");
  });

  test("getTransactions — uses accountNumber override in URL", async () => {
    queueResponses(mockResponse(loginSuccessBody), mockResponse(multiDateTransactions));

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    await client.getTransactions({ accountNumber: "9999999999" });

    expect(getCallUrl(1)).toContain("9999999999");
  });

  // --- reLogin (401 retry + proactive refresh) ---

  test("fetchTransactions — re-login on 401 and retries the request", async () => {
    // Queue: login, then fetch→401, then re-login (new token), then retry fetch→200
    const newLoginBody = { ...loginSuccessBody, access_token: "new-access-token" };
    queueResponses(
      mockResponse(loginSuccessBody), // initial login
      mockResponse({ message: "Unauthorized" }, 401), // first fetch → 401
      mockResponse(newLoginBody), // re-login (afterResponse hook)
      mockResponse(transactionList), // retry fetch → 200
    );

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    const transactions = await client.fetchTransactions();

    expect(transactions).toHaveLength(1);
    // The retried request should use the new token
    const retryHeaders = getCallHeaders(3);
    expect(retryHeaders["authorization"]).toBe("Bearer new-access-token");
  });

  test("reLogin — uses stored credentials with grant_type=password", async () => {
    queueResponses(mockResponse(loginSuccessBody), mockResponse(loginSuccessBody));

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();

    // Trigger reLogin via private method
    const anyClient = client as unknown as { reLogin(): Promise<void> };
    await anyClient.reLogin();

    // The re-login call should be a POST to the token endpoint
    const reLoginCall = capturedCalls[1];
    expect(reLoginCall.method).toBe("POST");
    const url = new URL(reLoginCall.url);
    expect(url.origin + url.pathname).toBe("https://api.khanbank.com:9003/v3/cfrm/auth/token");
    expect(url.searchParams.get("grant_type")).toBe("password");
    expect(url.searchParams.get("username")).toBe("testuser");
    const body = getCallBody(1);
    expect(body.grant_type).toBe("password");
    expect(body.username).toBe("testuser");
  });

  test("reLogin — dedupes concurrent calls", async () => {
    queueResponses(
      mockResponse(loginSuccessBody), // initial login
      mockResponse(loginSuccessBody), // only ONE re-login response
    );

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();

    // Fire two concurrent reLogin calls
    const anyClient = client as unknown as { reLogin(): Promise<void> };
    await Promise.all([anyClient.reLogin(), anyClient.reLogin()]);

    // Only one re-login HTTP call should have been made (call index 1)
    // Call 0 = initial login, call 1 = the single shared re-login
    expect(capturedCalls).toHaveLength(2);
  });

  test("reLogin — throws KhaanAuthError when re-login requires MFA", async () => {
    queueResponses(
      mockResponse(loginSuccessBody), // initial login
      mockResponse(mfaRequiredBody), // re-login returns MFA required (no access_token)
    );

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();

    const anyClient = client as unknown as { reLogin(): Promise<void> };
    await expect(anyClient.reLogin()).rejects.toThrow(KhaanAuthError);
  });
});
