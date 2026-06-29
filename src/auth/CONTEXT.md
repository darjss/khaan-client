# Auth

Khan Bank authentication: initial login, SOTP OTP dispatch + submit, device remembering, and token refresh.

## Language

**Login**:
The act of authenticating with Khan Bank. May complete in one step (no MFA) or require an OTP.
_Avoid_: Sign in, authentication

**SOTP**:
SMS One-Time Password. The secondary authentication mode where Khan Bank sends a numeric code to the user's registered phone/email.
_Avoid_: OTP code, verification code, SMS code

**Request ID**:
A server-issued identifier (`unique_id`) returned by the initial login step when MFA is required. Used to correlate the SOTP dispatch and OTP submit steps.
_Avoid_: Session id, MFA id, correlation id

**Remember Device**:
A flag (`rememberDevice: "Y"`) sent during OTP submit that tells Khan Bank to skip MFA for future logins from the same device-id.
_Avoid_: Trust device, whitelist device

**Access Token**:
A short-lived bearer token (~300s) returned by a successful login. Used to authorize transaction and account API calls.
_Avoid_: Session token, auth token

**Refresh Token**:
A longer-lived token returned alongside the access token. Used to obtain a new access token without re-login.
_Avoid_: Renewal token
