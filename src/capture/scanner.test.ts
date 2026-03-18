import { describe, expect, test } from "bun:test";
import { scanForSecrets } from "./scanner.js";

describe("scanForSecrets", () => {
  test("returns empty for clean text", () => {
    const findings = scanForSecrets("Hello world, nothing secret here");
    expect(findings).toEqual([]);
  });

  test("returns empty for empty text", () => {
    expect(scanForSecrets("")).toEqual([]);
  });

  test("detects OpenAI API keys", () => {
    const text = "Using key sk-abcdefghijklmnopqrstuv12345 for API";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0]!.finding_type).toBe("api_key");
    expect(findings[0]!.severity).toBe("critical");
    expect(findings[0]!.pattern_name).toBe("OpenAI API keys");
    expect(findings[0]!.snippet).not.toContain("sk-abcdefghijklmnopqrstuv12345");
    expect(findings[0]!.snippet).toContain("[REDACTED_API_KEY]");
  });

  test("detects AWS access keys", () => {
    const text = "aws_key = AKIAIOSFODNN7EXAMPLE";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0]!.finding_type).toBe("api_key");
    expect(findings[0]!.severity).toBe("critical");
  });

  test("detects PostgreSQL connection strings", () => {
    const text = "DATABASE_URL=postgresql://user:pass@host:5432/db";
    const findings = scanForSecrets(text);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    const dbFinding = findings.find((f) => f.finding_type === "db_url");
    expect(dbFinding).toBeDefined();
    expect(dbFinding!.severity).toBe("high");
  });

  test("detects MongoDB connection strings", () => {
    const text = "MONGO=mongodb://user:pass@host:27017/db";
    const findings = scanForSecrets(text);
    const dbFinding = findings.find((f) => f.finding_type === "db_url");
    expect(dbFinding).toBeDefined();
    expect(dbFinding!.severity).toBe("high");
  });

  test("detects MySQL connection strings", () => {
    const text = "mysql://root:password@localhost/mydb";
    const findings = scanForSecrets(text);
    const dbFinding = findings.find((f) => f.finding_type === "db_url");
    expect(dbFinding).toBeDefined();
  });

  test("detects passwords in config", () => {
    const text = "password=supersecret123";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0]!.finding_type).toBe("password");
    expect(findings[0]!.severity).toBe("high");
  });

  test("detects Bearer tokens", () => {
    const text = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0=';
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0]!.finding_type).toBe("token");
    expect(findings[0]!.severity).toBe("medium");
  });

  test("detects GitHub personal access tokens", () => {
    const text = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0]!.finding_type).toBe("token");
    expect(findings[0]!.severity).toBe("high");
  });

  test("detects GitHub fine-grained PATs", () => {
    const text = "GITHUB_TOKEN=github_pat_ABCDEFGHIJKLMNOPQRSTUVx";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0]!.finding_type).toBe("token");
  });

  test("detects Candengo API keys", () => {
    const text = "key=cvk_" + "a".repeat(64);
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0]!.finding_type).toBe("api_key");
    expect(findings[0]!.severity).toBe("critical");
  });

  test("detects Slack tokens", () => {
    const text = "SLACK_TOKEN=xoxb-1234567890-abcdef";
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0]!.finding_type).toBe("token");
  });

  test("detects multiple secrets in same text", () => {
    const text = "API=sk-abcdefghijklmnopqrstuv12345 DB=postgresql://user:pass@host/db";
    const findings = scanForSecrets(text);
    expect(findings.length).toBeGreaterThanOrEqual(2);
  });

  test("redacted snippet does not contain actual secret", () => {
    const secret = "sk-" + "a".repeat(30);
    const text = `The key is ${secret} and more text`;
    const findings = scanForSecrets(text);
    expect(findings.length).toBe(1);
    expect(findings[0]!.snippet).not.toContain(secret);
  });

  test("custom patterns work", () => {
    const text = "MY_SECRET_VALUE_12345";
    const findings = scanForSecrets(text, ["MY_SECRET_VALUE_\\d+"]);
    expect(findings.length).toBe(1);
    expect(findings[0]!.finding_type).toBe("custom");
    expect(findings[0]!.severity).toBe("medium");
  });

  test("invalid custom patterns are skipped", () => {
    const text = "sk-abcdefghijklmnopqrstuv12345";
    // Invalid regex should not crash
    const findings = scanForSecrets(text, ["[invalid"]);
    expect(findings.length).toBe(1); // still finds the OpenAI key
  });
});
