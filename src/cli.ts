#!/usr/bin/env node
/**
 * khaan-client CLI
 *
 * Usage:
 *   npx khaan-client remember-device
 *     → prompts for username, password, OTP
 *     → calls login({ onOtp }) with rememberDevice: "Y"
 *     → device is now remembered at Khan Bank for this deviceId
 *     → prints "Device remembered. Use this deviceId in prod: <uuid>"
 *
 *   npx khaan-client remember-device --username foo --password bar
 *     → only prompts for OTP
 *
 *   npx khaan-client remember-device --generate-device-id
 *     → generates a new UUID, uses it, prints it for you to save in env
 *
 *   npx khaan-client remember-device --account-number 1234567890
 *     → account number for fetchTransactions (optional for remember-device)
 */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { randomUUID } from "node:crypto";
import { KhaanClient } from "./auth/client.ts";

const prompt = async (question: string): Promise<string> => {
  const rl = createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
};

const main = async (): Promise<void> => {
  const { values, positionals } = parseArgs({
    options: {
      command: { type: "string", short: "c" },
      username: { type: "string", short: "u" },
      password: { type: "string", short: "p" },
      "device-id": { type: "string", short: "d" },
      "generate-device-id": { type: "boolean", default: false },
      "account-number": { type: "string", short: "a" },
      "user-agent": { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
  });

  if (values.help || (!values.command && positionals.length === 0)) {
    console.log(`khaan-client CLI

Usage:
  npx khaan-client remember-device [options]

Commands:
  remember-device    Login with SOTP + rememberDevice so future logins skip MFA

Options:
  -u, --username <user>       Khan Bank username (prompts if omitted)
  -p, --password <pass>       Khan Bank password (prompts if omitted)
  -d, --device-id <uuid>      Device ID to remember (prompts/generates if omitted)
  --generate-device-id        Generate a new UUID for device-id
  -a, --account-number <num>  Account number (optional for remember-device)
  --user-agent <ua>           Custom User-Agent string
  -h, --help                  Show this help
`);
    return;
  }

  const command = values.command ?? positionals[0];

  if (command === "remember-device") {
    await rememberDevice(values);
    return;
  }

  console.error(`Unknown command: ${command}`);
  console.error("Run with --help for usage.");
  process.exit(1);
};

async function rememberDevice(values: Record<string, unknown>): Promise<void> {
  const username = (values.username as string) ?? (await prompt("Username: "));
  const password = (values.password as string) ?? (await prompt("Password: "));

  let deviceId = values["device-id"] as string | undefined;
  if (!deviceId) {
    if (values["generate-device-id"]) {
      deviceId = randomUUID();
      console.log(`Generated device ID: ${deviceId}`);
    } else {
      deviceId = await prompt("Device ID (or leave empty to generate): ");
      if (!deviceId) {
        deviceId = randomUUID();
        console.log(`Generated device ID: ${deviceId}`);
      }
    }
  }

  const accountNumber = (values["account-number"] as string) ?? "";
  const userAgent = values["user-agent"] as string | undefined;

  const client = new KhaanClient({
    username,
    password,
    deviceId,
    accountNumber,
    userAgent,
  });

  console.log("Logging in...");
  const initial = await client.loginInitial();

  if (initial.status === "logged_in") {
    console.log("Already logged in — device is already remembered.");
    console.log(`\nDevice ID: ${deviceId}`);
    console.log("Save this in your env: KHAAN_DEVICE_ID=" + deviceId);
    return;
  }

  console.log("MFA required. Dispatching OTP...");
  await client.dispatchOtp(initial.requestId);

  const otp = await prompt("OTP (from SMS/email): ");

  console.log("Submitting OTP + remembering device...");
  await client.submitOtp(initial.requestId, otp);

  console.log("\n✓ Device remembered.");
  console.log(`\nDevice ID: ${deviceId}`);
  console.log("Save this in your env: KHAAN_DEVICE_ID=" + deviceId);
  console.log("\nFuture logins with this device ID will skip MFA.");
}

main().catch((error) => {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
