import { describe, expect, test } from "bun:test";
import { scrubSecrets, containsSecrets, scrubFleetIdentifiers } from "./scrubber.js";

describe("scrubSecrets", () => {
  test("scrubs OpenAI API keys", () => {
    const input = "key is sk-abc123def456ghi789jkl012mno";
    const result = scrubSecrets(input);
    expect(result).toBe("key is [REDACTED_API_KEY]");
    expect(result).not.toContain("sk-");
  });

  test("scrubs Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED_BEARER]");
    expect(result).not.toContain("eyJhbG");
  });

  test("scrubs passwords", () => {
    const input = "password=super_secret_123";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("super_secret");
  });

  test("scrubs password with colon separator", () => {
    const input = "Password: mysecretpass";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("mysecretpass");
  });

  test("scrubs PostgreSQL connection strings", () => {
    const input = "db: postgresql://user:pass@localhost:5432/mydb";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED_DB_URL]");
    expect(result).not.toContain("user:pass");
  });

  test("scrubs MongoDB connection strings", () => {
    const input = "mongodb://admin:pass@mongo.example.com/db";
    const result = scrubSecrets(input);
    expect(result).toBe("[REDACTED_DB_URL]");
  });

  test("scrubs MySQL connection strings", () => {
    const input = "mysql://root:password@localhost/mydb";
    const result = scrubSecrets(input);
    expect(result).toBe("[REDACTED_DB_URL]");
  });

  test("scrubs AWS access keys", () => {
    const input = "aws_key=AKIAIOSFODNN7EXAMPLE";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED_AWS_KEY]");
    expect(result).not.toContain("AKIAIOSFODNN");
  });

  test("scrubs GitHub personal access tokens", () => {
    const input = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED_GH_TOKEN]");
    expect(result).not.toContain("ghp_");
  });

  test("scrubs GitHub OAuth tokens", () => {
    const input = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
    const result = scrubSecrets(input);
    expect(result).toBe("[REDACTED_GH_TOKEN]");
  });

  test("scrubs GitHub fine-grained PATs", () => {
    const input = "github_pat_abcdefghijklmnopqrstuv1234";
    const result = scrubSecrets(input);
    expect(result).toBe("[REDACTED_GH_TOKEN]");
  });

  test("scrubs Candengo API keys", () => {
    const key = "cvk_" + "a".repeat(64);
    const result = scrubSecrets(`key=${key}`);
    expect(result).toContain("[REDACTED_CANDENGO_KEY]");
    expect(result).not.toContain("cvk_");
  });

  test("scrubs Slack tokens", () => {
    const input = "slack: xoxb-123456789-abcdef";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED_SLACK_TOKEN]");
    expect(result).not.toContain("xoxb-");
  });

  test("leaves clean text unchanged", () => {
    const input = "This is a normal observation about fixing a bug";
    expect(scrubSecrets(input)).toBe(input);
  });

  test("scrubs multiple secrets in one string", () => {
    const input =
      "Used sk-abc123def456ghi789jkl012mno to connect to postgresql://user:pass@db/app";
    const result = scrubSecrets(input);
    expect(result).toContain("[REDACTED_API_KEY]");
    expect(result).toContain("[REDACTED_DB_URL]");
    expect(result).not.toContain("sk-");
    expect(result).not.toContain("postgresql://");
  });

  test("custom patterns are applied", () => {
    const input = "internal_token_ABC123XYZ";
    const result = scrubSecrets(input, ["internal_token_[A-Z0-9]+"]);
    expect(result).toBe("[REDACTED_CUSTOM]");
  });

  test("invalid custom patterns are skipped gracefully", () => {
    const input = "normal text";
    const result = scrubSecrets(input, ["[invalid"]);
    expect(result).toBe("normal text");
  });

  test("empty text returns empty", () => {
    expect(scrubSecrets("")).toBe("");
  });
});

describe("containsSecrets", () => {
  test("detects OpenAI key", () => {
    expect(
      containsSecrets("has sk-abc123def456ghi789jkl012mno inside")
    ).toBe(true);
  });

  test("detects AWS key", () => {
    expect(containsSecrets("AKIAIOSFODNN7EXAMPLE")).toBe(true);
  });

  test("returns false for clean text", () => {
    expect(containsSecrets("no secrets here")).toBe(false);
  });

  test("detects custom patterns", () => {
    expect(
      containsSecrets("has INTERNAL_SECRET_123", ["INTERNAL_SECRET_\\d+"])
    ).toBe(true);
  });
});

describe("fleet identifier scrubbing", () => {
  test("redacts IPs, MACs, and hostnames", () => {
    const input = "host edge-01.example.net ip 10.20.30.40 mac aa:bb:cc:dd:ee:ff";
    const scrubbed = scrubFleetIdentifiers(input);
    expect(scrubbed).not.toContain("edge-01.example.net");
    expect(scrubbed).not.toContain("10.20.30.40");
    expect(scrubbed).not.toContain("aa:bb:cc:dd:ee:ff");
    expect(scrubbed).toContain("[REDACTED_HOSTNAME]");
    expect(scrubbed).toContain("[REDACTED_IP]");
    expect(scrubbed).toContain("[REDACTED_MAC]");
  });
});
