import { cookies } from "next/headers";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as signIn } from "@/app/api/auth/sign-in/route";
import { POST as signOut } from "@/app/api/auth/sign-out/route";
import { POST as signUp } from "@/app/api/auth/sign-up/route";
import { GET as confirm } from "@/app/auth/confirm/route";

// Uses the real Supabase SSR client. Only the cookie store and the network
// are replaced, to check that a session from Supabase Auth reaches cookies.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

type CookieStore = Awaited<ReturnType<typeof cookies>>;

const session = {
  access_token: "access-token",
  refresh_token: "refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: {
    id: "0b9c2b0e-4f1a-4c3e-9d2a-7f6e5d4c3b2a",
    aud: "authenticated",
    email: "user@example.com",
    app_metadata: {},
    user_metadata: {},
    created_at: "2026-11-21T00:00:00Z",
  },
};

let jar: Map<string, string>;
let authRequests: string[];

function respondWith(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      authRequests.push(new URL(input instanceof Request ? input.url : input).pathname);
      return Response.json(body, {
        status,
        headers: { "x-supabase-api-version": "2024-01-01" },
      });
    }),
  );
}

// Answers each Supabase Auth endpoint with its own status and body. A null
// body makes the request fail as if the service were unreachable.
function respondByPath(responses: Record<string, [number, unknown]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input);
      authRequests.push(url.pathname + url.search);

      const [status, body] = responses[url.pathname] ?? [404, {}];
      if (body === null) throw new TypeError("fetch failed");
      return status === 204
        ? new Response(null, { status })
        : Response.json(body, {
            status,
            headers: { "x-supabase-api-version": "2024-01-01" },
          });
    }),
  );
}

function signInRequest() {
  return new Request("http://localhost:3000/api/auth/sign-in", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "user@example.com", password: "secret123" }),
  });
}

// Supabase stores the session in sb-<project>-auth-token, possibly split
// into numbered chunks.
function sessionCookies() {
  return [...jar.keys()].filter((name) => /^sb-.+-auth-token(\.\d+)?$/.test(name));
}

beforeEach(() => {
  jar = new Map();
  authRequests = [];
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "test-publishable-key");
  vi.mocked(cookies).mockResolvedValue({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      if (value === "") jar.delete(name);
      else jar.set(name, value);
    },
  } as unknown as CookieStore);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("session cookies", () => {
  it("stores the session after registration without email confirmation", async () => {
    respondWith(200, session);

    const response = await signUp(
      new Request("http://localhost:3000/api/auth/sign-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com", password: "secret123" }),
      }),
    );

    expect(response.status).toBe(202);
    expect(authRequests).toEqual(["/auth/v1/signup"]);
    expect(sessionCookies()).not.toHaveLength(0);
    expect(await response.text()).not.toContain("access-token");
  });

  it("stores no session for an already registered email", async () => {
    respondWith(422, {
      code: 422,
      error_code: "user_already_exists",
      msg: "User already registered",
    });

    const response = await signUp(
      new Request("http://localhost:3000/api/auth/sign-up", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "user@example.com", password: "secret123" }),
      }),
    );

    expect(response.status).toBe(202);
    expect(sessionCookies()).toHaveLength(0);
  });

  it("stores the session after email confirmation", async () => {
    respondWith(200, session);

    const response = await confirm(
      new NextRequest("http://localhost:3000/auth/confirm?token_hash=pkce_abc&type=email"),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("http://localhost:3000/");
    expect(authRequests).toEqual(["/auth/v1/verify"]);
    expect(sessionCookies()).not.toHaveLength(0);
  });

  it("stores no session when confirmation fails", async () => {
    respondWith(403, {
      code: 403,
      error_code: "otp_expired",
      msg: "Email link is invalid or has expired",
    });

    const response = await confirm(
      new NextRequest("http://localhost:3000/auth/confirm?token_hash=pkce_abc&type=email"),
    );

    expect(response.headers.get("Location")).toBe(
      "http://localhost:3000/?error=confirmation_failed",
    );
    expect(sessionCookies()).toHaveLength(0);
  });

  it("stores the session after sign-in", async () => {
    respondByPath({ "/auth/v1/token": [200, session] });

    const response = await signIn(signInRequest());

    expect(response.status).toBe(200);
    expect(authRequests).toEqual(["/auth/v1/token?grant_type=password"]);
    expect(sessionCookies()).not.toHaveLength(0);
    expect(await response.text()).not.toMatch(/access-token|refresh-token/);
  });

  it("stores no session after a failed sign-in", async () => {
    respondByPath({
      "/auth/v1/token": [
        400,
        { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" },
      ],
    });

    expect((await signIn(signInRequest())).status).toBe(401);
    expect(sessionCookies()).toHaveLength(0);
  });

  it("removes the session cookies and revokes only the current session", async () => {
    respondByPath({ "/auth/v1/token": [200, session], "/auth/v1/logout": [204, {}] });
    await signIn(signInRequest());
    expect(sessionCookies()).not.toHaveLength(0);

    const response = await signOut();

    expect(response.status).toBe(200);
    expect(sessionCookies()).toHaveLength(0);
    expect(authRequests.at(-1)).toBe("/auth/v1/logout?scope=local");
  });

  it("succeeds without a session and without calling Supabase Auth", async () => {
    respondByPath({});

    const response = await signOut();

    expect(response.status).toBe(200);
    expect(authRequests).toEqual([]);
    expect(sessionCookies()).toHaveLength(0);
  });

  it("removes an expired session whose refresh token was rejected", async () => {
    respondByPath({
      "/auth/v1/token": [200, { ...session, expires_at: Math.floor(Date.now() / 1000) - 60 }],
    });
    await signIn(signInRequest());
    expect(sessionCookies()).not.toHaveLength(0);

    respondByPath({
      "/auth/v1/token": [
        400,
        { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" },
      ],
    });
    const response = await signOut();

    expect(response.status).toBe(200);
    expect(sessionCookies()).toHaveLength(0);
    expect(authRequests).toContain("/auth/v1/token?grant_type=refresh_token");
    expect(authRequests).not.toContain("/auth/v1/logout?scope=local");
  });

  it("still removes the cookies when Supabase Auth is unreachable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    respondByPath({ "/auth/v1/token": [200, session] });
    await signIn(signInRequest());

    respondByPath({ "/auth/v1/logout": [0, null] });
    const response = await signOut();

    // The revocation could not be confirmed, but this browser is signed out.
    expect(response.status).toBe(500);
    expect(sessionCookies()).toHaveLength(0);
  });
});
