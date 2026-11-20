import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/sign-in/route";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type Client = Awaited<ReturnType<typeof createClient>>;

const credentials = { email: "user@example.com", password: "secret123" };
const user = { id: "0b9c2b0e-4f1a-4c3e-9d2a-7f6e5d4c3b2a", email: "user@example.com" };

// Supabase client whose signInWithPassword returns the given error, or a session.
function mockSignIn(error: Error | null = null) {
  const signInWithPassword = vi.fn().mockResolvedValue(
    error
      ? { data: { user: null, session: null }, error }
      : {
          data: {
            user: { ...user, user_metadata: { name: "Private" }, app_metadata: {} },
            session: { access_token: "access-token", refresh_token: "refresh-token" },
          },
          error: null,
        },
  );
  vi.mocked(createClient).mockResolvedValue({
    auth: { signInWithPassword },
  } as unknown as Client);
  return signInWithPassword;
}

function signInRequest(body: unknown, contentType = "application/json") {
  return new Request("http://localhost/api/auth/sign-in", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(body);
}

const invalidCredentials = { error: "Invalid email or password" };

beforeEach(() => {
  vi.mocked(createClient).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/sign-in", () => {
  it("signs in with the trimmed email and returns only the user ID and email", async () => {
    const signInWithPassword = mockSignIn();

    const response = await POST(
      signInRequest({ email: " user@example.com ", password: "secret123" }),
    );

    await expectJson(response, 200, user);
    expect(signInWithPassword).toHaveBeenCalledWith(credentials);
  });

  it("never returns tokens, the password or user metadata", async () => {
    mockSignIn();

    const text = await (await POST(signInRequest(credentials))).text();

    for (const secret of ["access-token", "refresh-token", "secret123", "Private"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("returns 415 for a non-JSON content type", async () => {
    await expectJson(await POST(signInRequest(credentials, "text/plain")), 415, {
      error: "Content-Type must be application/json",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON and non-object bodies", async () => {
    await expectJson(await POST(signInRequest("{")), 400, {
      error: "Request body must be valid JSON",
    });
    await expectJson(await POST(signInRequest([credentials])), 400, {
      error: "Request body must be a JSON object",
    });
  });

  it.each([
    {},
    { email: "user@example.com" },
    { password: "secret123" },
    { email: " ", password: "secret123" },
    { email: "user@example.com", password: "" },
    { email: ["user@example.com"], password: "secret123" },
    { email: "user@example.com", password: 123456 },
  ])("returns 400 for missing credentials %j", async (body) => {
    await expectJson(await POST(signInRequest(body)), 400, {
      error: "Email and password are required",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 401 for invalid credentials", async () => {
    mockSignIn(new AuthApiError("Invalid login credentials", 400, "invalid_credentials"));
    await expectJson(await POST(signInRequest(credentials)), 401, invalidCredentials);
  });

  it("answers an unknown email exactly like a wrong password", async () => {
    // Supabase Auth returns invalid_credentials in both cases.
    mockSignIn(new AuthApiError("Invalid login credentials", 400, "invalid_credentials"));
    const wrongPassword = await POST(
      signInRequest({ email: "user@example.com", password: "wrong-pass" }),
    );

    mockSignIn(new AuthApiError("Invalid login credentials", 400, "invalid_credentials"));
    const unknownEmail = await POST(
      signInRequest({ email: "nobody@example.com", password: "secret123" }),
    );

    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(await unknownEmail.json()).toEqual(await wrongPassword.json());
  });

  it("returns 403 for an unconfirmed email", async () => {
    mockSignIn(new AuthApiError("Email not confirmed", 400, "email_not_confirmed"));
    await expectJson(await POST(signInRequest(credentials)), 403, {
      error: "Email address is not confirmed",
    });
  });

  it("returns 429 when Supabase Auth rate limits the request", async () => {
    mockSignIn(new AuthApiError("Rate limit", 429, "over_request_rate_limit"));
    await expectJson(await POST(signInRequest(credentials)), 429, {
      error: "Too many requests",
    });
  });

  it.each([
    new AuthRetryableFetchError("fetch failed for user@example.com", 0),
    new AuthApiError("Unexpected failure for user@example.com", 500, "unexpected_failure"),
  ])("returns 500, not 401, when Supabase Auth fails (%s)", async (error) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSignIn(error);

    await expectJson(await POST(signInRequest(credentials)), 500, {
      error: "Internal server error",
    });
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain("user@example.com");
    expect(logged).not.toContain("secret123");
  });
});
