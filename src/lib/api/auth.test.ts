import { describe, expect, it, vi } from "vitest";
import { authenticate } from "@/lib/api/auth";
import { requireUser } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));

type Auth = Awaited<ReturnType<typeof requireUser>>;

describe("authenticate", () => {
  it("returns the user and client from requireUser", async () => {
    const auth = { user: { id: "user-1" }, supabase: {} } as unknown as Auth;
    vi.mocked(requireUser).mockResolvedValue(auth);

    expect(await authenticate()).toBe(auth);
  });

  it("returns 401 without a valid session", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);

    const response = (await authenticate()) as Response;

    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });

  it("does not turn an Auth outage into a 401", async () => {
    const outage = new Error("fetch failed");
    vi.mocked(requireUser).mockRejectedValue(outage);

    // The error reaches Next.js, which responds with 500.
    await expect(authenticate()).rejects.toBe(outage);
  });
});
