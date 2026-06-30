export type KhaanClientConfig = {
  username: string;
  password: string;
  deviceId: string;
  userAgent?: string;
  accountNumber: string;
  branchCode?: string;
};

export type KhaanLoginResult =
  | { status: "logged_in"; accessToken: string }
  | { status: "mfa_required"; requestId: string };

/** Internal token cache state. */
export type TokenState = {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms when the access token expires. */
  expiresAt: number;
};
