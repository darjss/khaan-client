import { HTTPError, isHTTPError, isNetworkError, isTimeoutError } from "ky";
import * as v from "valibot";
import {
  KhaanApiError,
  KhaanAuthError,
  KhaanError,
  KhaanNetworkError,
  KhaanRateLimitError,
} from "../errors.ts";
import { ErrorResponseSchema } from "./schemas.ts";

/** Base64-encode a string (works in browser and Node). */
export const base64Encode = (value: string): string => {
  if (typeof btoa === "function") return btoa(value);
  return Buffer.from(value, "utf-8").toString("base64");
};

/**
 * Extract a human-readable message from a ky HTTPError.
 * ky pre-parses the response body into `error.data` (JSON object or string).
 * Khan Bank returns JSON errors with Mongolian messages.
 */
export const extractErrorMessage = (error: HTTPError): string => {
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
 * Used in the ky `beforeError` hook so callers get typed errors.
 */
export const classifyHttpError = (error: HTTPError): KhaanError => {
  const status = error.response.status;
  const message = extractErrorMessage(error);
  const endpoint = error.request.url;
  const opts = { statusCode: status, endpoint };

  if (status === 429) return new KhaanRateLimitError(message, opts);
  if (status === 401 || status === 403) return new KhaanAuthError(message, opts);
  return new KhaanApiError(message, opts);
};

/**
 * ky `beforeError` hook that classifies all ky errors into typed KhaanErrors.
 * HTTPError → Auth/RateLimit/Api by status. Network/Timeout → KhaanNetworkError.
 * Unknown ky errors default to KhaanNetworkError so callers always get a typed error.
 */
export const classifyKyError = (error: Error): KhaanError => {
  if (error instanceof KhaanError) return error;
  if (isHTTPError(error)) return classifyHttpError(error);
  if (isNetworkError(error) || isTimeoutError(error)) {
    return new KhaanNetworkError(`Network error: ${error.message}`, {
      endpoint: "request" in error ? (error.request as Request).url : undefined,
      cause: error,
    });
  }
  return new KhaanNetworkError(`Network error: ${error.message}`, { cause: error });
};
