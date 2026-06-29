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

/** Safely extract the JSON body from a mocked fetch call's RequestInit. */
const getCallBody = (calls: unknown[][], index: number): Record<string, string> => {
  const init = calls[index]?.[1] as RequestInit | undefined;
  return JSON.parse((init?.body ?? "{}") as string);
};

/** Safely extract the headers from a mocked fetch call's RequestInit. */
const getCallHeaders = (calls: unknown[][], index: number): Record<string, string> => {
  const init = calls[index]?.[1] as RequestInit | undefined;
  return (init?.headers ?? {}) as Record<string, string>;
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
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("loginInitial — returns logged_in when device is remembered", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(loginSuccessBody));

    const client = new KhaanClient(baseConfig);
    const result = await client.loginInitial();

    expect(result.status).toBe("logged_in");
    if (result.status === "logged_in") {
      expect(result.accessToken).toBe("test-access-token");
    }

    // Verify the request payload
    const calls = fetchSpy.mock.calls;
    expect(calls[0]?.[0]).toBe("https://e.khanbank.com/v3/cfrm/auth/token");
    const init = calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    const body = getCallBody(calls, 0);
    expect(body.username).toBe("testuser");
    expect(body.grant_type).toBe("password");
    expect(body.channelId).toBe("I");
    expect(body.languageId).toBe("003");
    // Password should be base64 encoded
    expect(body.password).toBe(btoa("testpass"));
  });

  test("loginInitial — returns mfa_required with requestId", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(mfaRequiredBody));

    const client = new KhaanClient(baseConfig);
    const result = await client.loginInitial();

    expect(result.status).toBe("mfa_required");
    if (result.status === "mfa_required") {
      expect(result.requestId).toBe("test-request-id");
    }
  });

  test("login — high-level with onOtp runs all 3 steps", async () => {
    // Step 1: MFA required
    fetchSpy.mockResolvedValueOnce(mockResponse(mfaRequiredBody));
    // Step 2: SOTP dispatch (returns body without access_token)
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: "OTP sent" }));
    // Step 3: OTP submit + rememberDevice → success
    fetchSpy.mockResolvedValueOnce(mockResponse(loginSuccessBody));

    const client = new KhaanClient(baseConfig);
    const onOtp = vi.fn().mockResolvedValue("123456");
    const result = await client.login({ onOtp });

    expect(result.accessToken).toBe("test-access-token");
    expect(onOtp).toHaveBeenCalledWith("test-request-id");

    // Verify step 2 payload (SOTP dispatch)
    const step2Body = getCallBody(fetchSpy.mock.calls, 1);
    expect(step2Body.isPrelogin).toBe("N");
    expect(step2Body.requestId).toBe("test-request-id");
    expect(step2Body.secondaryMode).toBe("SOTP");

    // Verify step 3 payload (OTP submit + rememberDevice)
    const step3Body = getCallBody(fetchSpy.mock.calls, 2);
    expect(step3Body.isPrelogin).toBe("N");
    expect(step3Body.requestId).toBe("test-request-id");
    expect(step3Body.secondaryMode).toBe("");
    expect(step3Body.rememberDevice).toBe("Y");
    // Password should be base64-encoded OTP
    expect(step3Body.password).toBe(btoa("123456"));
  });

  test("login — high-level without onOtp throws KhaanMfaError when MFA required", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(mfaRequiredBody));

    const client = new KhaanClient(baseConfig);

    await expect(client.login()).rejects.toThrow(KhaanMfaError);
  });

  test("login — completes in one step when device is remembered", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(loginSuccessBody));

    const client = new KhaanClient(baseConfig);
    const onOtp = vi.fn();
    const result = await client.login({ onOtp });

    expect(result.accessToken).toBe("test-access-token");
    expect(onOtp).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  test("dispatchOtp — sends SOTP dispatch request", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: "OTP sent" }));

    const client = new KhaanClient(baseConfig);
    await client.dispatchOtp("test-request-id");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = getCallBody(fetchSpy.mock.calls, 0);
    expect(body.secondaryMode).toBe("SOTP");
    expect(body.requestId).toBe("test-request-id");
  });

  test("submitOtp — submits OTP + rememberDevice, returns accessToken", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(loginSuccessBody));

    const client = new KhaanClient(baseConfig);
    const result = await client.submitOtp("test-request-id", "123456");

    expect(result.accessToken).toBe("test-access-token");
    const body = getCallBody(fetchSpy.mock.calls, 0);
    expect(body.rememberDevice).toBe("Y");
    expect(body.password).toBe(btoa("123456"));
  });

  test("submitOtp — throws KhaanMfaError when no access_token returned", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: "Invalid OTP" }, 200));

    const client = new KhaanClient(baseConfig);
    await expect(client.submitOtp("test-request-id", "wrong")).rejects.toThrow(KhaanMfaError);
  });

  test("fetchTransactions — returns parsed transaction list", async () => {
    // First: login to get a token
    fetchSpy.mockResolvedValueOnce(mockResponse(loginSuccessBody));
    // Then: transactions fetch
    fetchSpy.mockResolvedValueOnce(mockResponse(transactionList));

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
    fetchSpy.mockResolvedValueOnce(mockResponse(loginSuccessBody));
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: "Server error" }, 500));

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    await expect(client.fetchTransactions()).rejects.toThrow(KhaanApiError);
  });

  test("fetchTransactions — throws KhaanRateLimitError on 429", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(loginSuccessBody));
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: "Too many requests" }, 429));

    const client = new KhaanClient(baseConfig);
    await client.loginInitial();
    await expect(client.fetchTransactions()).rejects.toThrow(KhaanRateLimitError);
  });

  test("loginInitial — throws KhaanAuthError on 401", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse({ message: "Хэрэглэгчийн нэр эсвэл нууц үг буруу" }, 401),
    );

    const client = new KhaanClient(baseConfig);
    await expect(client.loginInitial()).rejects.toThrow(KhaanAuthError);
  });

  test("loginInitial — throws KhaanApiError on 500", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse({ message: "Серверийн алдаа" }, 500));

    const client = new KhaanClient(baseConfig);
    await expect(client.loginInitial()).rejects.toThrow(KhaanApiError);
  });

  test("headers — includes device-id, Accept-Language, secure", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(loginSuccessBody));

    const client = new KhaanClient({
      ...baseConfig,
      userAgent: "TestAgent/1.0",
    });
    await client.loginInitial();

    const headers = getCallHeaders(fetchSpy.mock.calls, 0);
    expect(headers["device-id"]).toBe("test-device-id");
    expect(headers["Accept-Language"]).toBe("mn-MN");
    expect(headers["secure"]).toBe("yes");
    expect(headers["User-Agent"]).toBe("TestAgent/1.0");
  });
});
