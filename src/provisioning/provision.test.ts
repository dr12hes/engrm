import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import {
  provision,
  ProvisionError,
  DEFAULT_CANDENGO_URL,
  type ProvisionResponse,
} from "./provision.js";

// Mock server using Bun.serve
let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let nextResponse: {
  status: number;
  body: unknown;
};

beforeEach(() => {
  nextResponse = {
    status: 200,
    body: {
      api_key: "cvk_test123456",
      site_id: "test-site",
      namespace: "test-ns",
      user_id: "david",
      user_email: "david@example.com",
      teams: [{ id: "team_1", name: "Unimpossible", namespace: "dev-memory" }],
    } satisfies ProvisionResponse,
  };

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/mem/provision" && req.method === "POST") {
        return new Response(JSON.stringify(nextResponse.body), {
          status: nextResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not found", { status: 404 });
    },
  });

  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server.stop(true);
});

describe("provision", () => {
  test("exchanges token for credentials", async () => {
    const result = await provision(baseUrl, { token: "cmt_abc123" });
    expect(result.api_key).toBe("cvk_test123456");
    expect(result.site_id).toBe("test-site");
    expect(result.namespace).toBe("test-ns");
    expect(result.user_id).toBe("david");
    expect(result.user_email).toBe("david@example.com");
    expect(result.teams).toHaveLength(1);
    expect(result.teams[0]!.id).toBe("team_1");
  });

  test("exchanges OAuth code for credentials", async () => {
    const result = await provision(baseUrl, { code: "auth_code_123" });
    expect(result.api_key).toBe("cvk_test123456");
  });

  test("sends device_name in request", async () => {
    let capturedBody: string | null = null;
    server.stop(true);
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method === "POST") {
          capturedBody = await req.text();
          return new Response(JSON.stringify(nextResponse.body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response("Not found", { status: 404 });
      },
    });
    baseUrl = `http://localhost:${server.port}`;

    await provision(baseUrl, {
      token: "cmt_test",
      device_name: "MacBook Pro",
    });
    expect(capturedBody!).toContain("MacBook Pro");
  });

  test("throws ProvisionError on 401", async () => {
    nextResponse = {
      status: 401,
      body: { detail: "Token expired" },
    };

    try {
      await provision(baseUrl, { token: "cmt_expired" });
      expect(true).toBe(false); // should not reach
    } catch (error) {
      expect(error).toBeInstanceOf(ProvisionError);
      expect((error as ProvisionError).status).toBe(401);
      expect((error as ProvisionError).detail).toBe(
        "Invalid or expired provisioning token"
      );
    }
  });

  test("throws ProvisionError on 409 (already used)", async () => {
    nextResponse = {
      status: 409,
      body: { detail: "Token already redeemed" },
    };

    try {
      await provision(baseUrl, { token: "cmt_used" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProvisionError);
      expect((error as ProvisionError).status).toBe(409);
      expect((error as ProvisionError).detail).toBe(
        "Token has already been used"
      );
    }
  });

  test("throws ProvisionError on 500", async () => {
    nextResponse = {
      status: 500,
      body: { detail: "Internal error" },
    };

    try {
      await provision(baseUrl, { token: "cmt_test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProvisionError);
      expect((error as ProvisionError).status).toBe(500);
    }
  });

  test("validates api_key format in response", async () => {
    nextResponse = {
      status: 200,
      body: {
        api_key: "bad_key",
        site_id: "s",
        namespace: "n",
        user_id: "u",
        user_email: "e",
        teams: [],
      },
    };

    try {
      await provision(baseUrl, { token: "cmt_test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProvisionError);
      expect((error as ProvisionError).detail).toContain("invalid API key");
    }
  });

  test("validates incomplete response", async () => {
    nextResponse = {
      status: 200,
      body: {
        api_key: "cvk_test123",
        site_id: "",
        namespace: "n",
        user_id: "u",
        user_email: "e",
        teams: [],
      },
    };

    try {
      await provision(baseUrl, { token: "cmt_test" });
      expect(true).toBe(false);
    } catch (error) {
      expect(error).toBeInstanceOf(ProvisionError);
      expect((error as ProvisionError).detail).toContain("incomplete");
    }
  });

  test("strips trailing slash from base URL", async () => {
    const result = await provision(baseUrl + "/", { token: "cmt_test" });
    expect(result.api_key).toBe("cvk_test123456");
  });
});

describe("DEFAULT_CANDENGO_URL", () => {
  test("points to production", () => {
    expect(DEFAULT_CANDENGO_URL).toBe("https://www.candengo.com");
  });
});
