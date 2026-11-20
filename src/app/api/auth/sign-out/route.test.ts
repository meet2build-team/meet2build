import { AuthApiError, AuthRetryableFetchError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/auth/sign-out/route";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type Client = Awaited<ReturnType<typeof createClient>>;

function mockSignOut(error: Error | null = null) {
  const signOut = vi.fn().mockResolvedValue({ error });
  vi.mocked(createClient).mockResolvedValue({ auth: { signOut } } as unknown as Client);
  return signOut;
}

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(body);
}

const signedOut = { message: "Signed out" };

beforeEach(() => {
  vi.mocked(createClient).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/sign-out", () => {
  it("signs out only the current session", async () => {
    const signOut = mockSignOut();

    await expectJson(await POST(), 200, signedOut);
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("succeeds without an active session", async () => {
    // Supabase Auth returns no error when there is no session to sign out.
    mockSignOut(null);
    await expectJson(await POST(), 200, signedOut);
  });

  it.each([
    new AuthApiError("Invalid Refresh Token: Refresh Token Not Found", 400, "refresh_token_not_found"),
    new AuthApiError("Session from session_id claim in JWT does not exist", 403, "session_not_found"),
  ])("succeeds when the session has already expired or been revoked (%s)", async (error) => {
    mockSignOut(error);
    await expectJson(await POST(), 200, signedOut);
  });

  it.each([
    new AuthRetryableFetchError("fetch failed", 0),
    new AuthApiError("Unexpected failure", 500, "unexpected_failure"),
  ])("returns 500 when Supabase Auth cannot confirm the sign-out (%s)", async (error) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSignOut(error);

    await expectJson(await POST(), 500, { error: "Internal server error" });
    expect(log).toHaveBeenCalledWith("Failed to sign out", {
      name: error.name,
      status: error.status,
      code: error.code,
    });
  });
});
