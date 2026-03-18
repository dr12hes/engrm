import { describe, test, expect } from "bun:test";
import { checkDailyLimit } from "./audit.js";
import { MemDatabase } from "../storage/sqlite.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

function createTestDb(): MemDatabase {
  const dbPath = join(tmpdir(), `sentinel-test-${randomBytes(4).toString("hex")}.db`);
  return new MemDatabase(dbPath);
}

describe("sentinel audit", () => {
  test("checkDailyLimit allows within limit", () => {
    const db = createTestDb();
    try {
      expect(checkDailyLimit(db, 10)).toBe(true);
      expect(checkDailyLimit(db, 10)).toBe(true);
    } finally {
      db.close();
    }
  });

  test("checkDailyLimit blocks when exceeded", () => {
    const db = createTestDb();
    try {
      for (let i = 0; i < 3; i++) {
        expect(checkDailyLimit(db, 3)).toBe(true);
      }
      expect(checkDailyLimit(db, 3)).toBe(false);
    } finally {
      db.close();
    }
  });
});
