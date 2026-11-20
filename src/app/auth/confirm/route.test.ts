import { AuthApiError } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/auth/confirm/route";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

type Client = Awaited<ReturnType<typeof createClient>>;

const tokenHash = "pkce_0123456789abcdef";
const failed = "http://localhost:3000/?error=confirmation_failed";

function mockVerifyOtp(error: Error | null = null) {
  const verifyOtp = vi.fn().mockResolvedValue({
    data: { user: null, session: null },
    error,
  });
  vi.mocked(createClient).mockResolvedValue({ auth: { verifyOtp } } as unknown as Client);
  return verifyOtp;
}

function confirm(query: Record<string, string>) {
  const url = new URL("http://localhost:3000/auth/confirm");
  for (const [name, value] of Object.entries(query)) {
    url.searchParams.set(name, value);
  }
  return GET(new NextRequest(url));
}

function expectRedirect(response: Response, location: string) {
  expect(response.status).toBe(303);
  expect(response.headers.get("Location")).toBe(location);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
}

beforeEach(() => {
  vi.mocked(createClient).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /auth/confirm", () => {
  it("verifies the token and redirects to the home page", async () => {
    const verifyOtp = mockVerifyOtp();

    const response = await confirm({ token_hash: tokenHash, type: "email" });

    expectRedirect(response, "http://localhost:3000/");
    expect(verifyOtp).toHaveBeenCalledWith({ type: "email", token_hash: tokenHash });
  });

  it("accepts the legacy signup type", async () => {
    const verifyOtp = mockVerifyOtp();

    expectRedirect(
      await confirm({ token_hash: tokenHash, type: "signup" }),
      "http://localhost:3000/",
    );
    expect(verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: tokenHash });
  });

  it("redirects to a path on this site given in next", async () => {
    mockVerifyOtp();

    expectRedirect(
      await confirm({ token_hash: tokenHash, type: "email", next: "/projects?tab=1#top" }),
      "http://localhost:3000/projects?tab=1#top",
    );
  });

  it.each([
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/\t/evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "projects",
  ])("ignores the unsafe next value %j", async (next) => {
    mockVerifyOtp();

    expectRedirect(
      await confirm({ token_hash: tokenHash, type: "email", next }),
      "http://localhost:3000/",
    );
  });

  it.each<Record<string, string>>([
    {},
    { type: "email" },
    { token_hash: tokenHash },
    { token_hash: tokenHash, type: "recovery" },
    { token_hash: tokenHash, type: "invite" },
    { token_hash: "", type: "email" },
  ])("rejects the incomplete or unsupported link %j", async (query) => {
    mockVerifyOtp();

    expectRedirect(await confirm(query), failed);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects an invalid or expired token without logging it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mockVerifyOtp(new AuthApiError("Token has expired or is invalid", 403, "otp_expired"));

    const response = await confirm({
      token_hash: tokenHash,
      type: "email",
      next: "/projects",
    });

    expectRedirect(response, failed);
    expect(response.headers.get("Location")).not.toContain(tokenHash);
    expect(JSON.stringify(log.mock.calls)).not.toContain(tokenHash);
  });
});
