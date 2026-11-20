import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/sign-up/route";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type Client = Awaited<ReturnType<typeof createClient>>;

const credentials = { email: "user@example.com", password: "secret123" };

// Supabase client whose signUp returns the given error, or a new user.
function mockSignUp(error: Error | null = null) {
  const signUp = vi.fn().mockResolvedValue({
    data: error ? { user: null, session: null } : { user: { id: "u1" }, session: null },
    error,
  });
  vi.mocked(createClient).mockResolvedValue({ auth: { signUp } } as unknown as Client);
  return signUp;
}

function signUpRequest(body: unknown, contentType = "application/json") {
  return new Request("http://localhost/api/auth/sign-up", {
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

const accepted = { message: "Registration received" };

beforeEach(() => {
  vi.mocked(createClient).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/sign-up", () => {
  it("registers the user with the trimmed email", async () => {
    const signUp = mockSignUp();

    const response = await POST(
      signUpRequest({ email: " user@example.com ", password: "secret123" }),
    );

    await expectJson(response, 202, accepted);
    expect(signUp).toHaveBeenCalledWith(credentials);
  });

  it("does not return user data, the password or tokens", async () => {
    const signUp = vi.fn().mockResolvedValue({
      data: {
        user: { id: "u1", email: "user@example.com" },
        session: { access_token: "access", refresh_token: "refresh" },
      },
      error: null,
    });
    vi.mocked(createClient).mockResolvedValue({ auth: { signUp } } as unknown as Client);

    const text = await (await POST(signUpRequest(credentials))).text();

    expect(JSON.parse(text)).toEqual(accepted);
    for (const secret of ["u1", "secret123", "access", "refresh"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("answers a duplicate email exactly like a new one", async () => {
    mockSignUp();
    const created = await POST(signUpRequest(credentials));

    mockSignUp(new AuthApiError("User already registered", 422, "user_already_exists"));
    const duplicate = await POST(signUpRequest(credentials));

    expect(duplicate.status).toBe(created.status);
    expect(await duplicate.json()).toEqual(await created.json());
  });

  it("returns 415 for a non-JSON content type", async () => {
    const response = await POST(signUpRequest(credentials, "text/plain"));

    await expectJson(response, 415, { error: "Content-Type must be application/json" });
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON", async () => {
    await expectJson(await POST(signUpRequest("{")), 400, {
      error: "Request body must be valid JSON",
    });
  });

  it.each([
    {},
    { email: "user@example.com" },
    { password: "secret123" },
    { email: "  ", password: "secret123" },
    { email: "user@example.com", password: "" },
    { email: 42, password: "secret123" },
    { email: "user@example.com", password: 123456 },
  ])("returns 400 for missing credentials %j", async (body) => {
    await expectJson(await POST(signUpRequest(body)), 400, {
      error: "Email and password are required",
    });
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    "user",
    "user@",
    "@example.com",
    "user@example",
    "user name@example.com",
    `${"a".repeat(243)}@example.com`,
  ])("returns 400 for the invalid email %s", async (email) => {
    await expectJson(
      await POST(signUpRequest({ email, password: "secret123" })),
      400,
      { error: "Invalid email address" },
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("returns 400 for a password shorter than 6 characters", async () => {
    await expectJson(
      await POST(signUpRequest({ email: "user@example.com", password: "12345" })),
      400,
      { error: "Password must be at least 6 characters" },
    );
    expect(createClient).not.toHaveBeenCalled();
  });

  it("accepts a password of exactly 6 characters", async () => {
    const signUp = mockSignUp();
    const response = await POST(
      signUpRequest({ email: "user@example.com", password: "123456" }),
    );

    expect(response.status).toBe(202);
    expect(signUp).toHaveBeenCalledOnce();
  });

  it.each([
    ["weak_password", 422, 400, "Password does not meet the requirements"],
    ["validation_failed", 400, 400, "Invalid email or password"],
    ["email_address_invalid", 400, 400, "Invalid email address"],
    ["signup_disabled", 422, 403, "Registration is disabled"],
    ["over_request_rate_limit", 429, 429, "Too many requests"],
    ["over_email_send_rate_limit", 429, 429, "Too many requests"],
  ])("maps the Supabase error %s to %i", async (code, supabaseStatus, status, error) => {
    mockSignUp(new AuthApiError("Supabase message", supabaseStatus, code));
    await expectJson(await POST(signUpRequest(credentials)), status, { error });
  });

  it("returns 500 without leaking details when Supabase Auth fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSignUp(new AuthRetryableFetchError("fetch failed for user@example.com", 0));

    await expectJson(await POST(signUpRequest(credentials)), 500, {
      error: "Internal server error",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain("user@example.com");
    expect(JSON.stringify(log.mock.calls)).not.toContain("secret123");
  });
});
