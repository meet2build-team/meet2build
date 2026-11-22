import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticate, requireProjectRole } from "@/lib/api/auth";
import { requireUser } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));

type Auth = Awaited<ReturnType<typeof requireUser>>;

const projectId = "0b9c2b0e-4f1a-4c3e-9d2a-7f6e5d4c3b2a";

// Signs in user-1 with a client whose project_members lookup returns `result`.
function signInWithMembership(result: { data: unknown; error: unknown }) {
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((): typeof query => query),
    maybeSingle: vi.fn(async () => result),
  };
  const supabase = { from: vi.fn(() => query) };
  const auth = { user: { id: "user-1" }, supabase };
  vi.mocked(requireUser).mockResolvedValue(auth as unknown as Auth);
  return { auth, supabase, query };
}

async function expectError(result: unknown, status: number, error: string) {
  expect(result).toBeInstanceOf(Response);
  const response = result as Response;
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ error });
}

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("requireProjectRole", () => {
  it("returns 401 without a valid session", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectError(await requireProjectRole(projectId, "member"), 401, "Unauthorized");
  });

  it("returns 400 for an invalid project ID", async () => {
    const { supabase } = signInWithMembership({ data: null, error: null });

    await expectError(await requireProjectRole("abc", "member"), 400, "Invalid project ID");
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("looks up only the signed-in user's membership in the project", async () => {
    const { supabase, query } = signInWithMembership({
      data: { role: "member" },
      error: null,
    });

    await requireProjectRole(projectId, "member");

    expect(supabase.from).toHaveBeenCalledWith("project_members");
    expect(query.select).toHaveBeenCalledWith("role");
    expect(query.eq).toHaveBeenCalledWith("project_id", projectId);
    expect(query.eq).toHaveBeenCalledWith("user_id", "user-1");
  });

  it.each(["member", "owner"] as const)(
    "returns 404 for a non-member when %s is required",
    async (requiredRole) => {
      // RLS returns no row for a missing project and for a non-member alike.
      signInWithMembership({ data: null, error: null });
      await expectError(
        await requireProjectRole(projectId, requiredRole),
        404,
        "Project not found",
      );
    },
  );

  it.each([
    ["owner", "owner"],
    ["owner", "member"],
    ["member", "member"],
  ] as const)("allows an %s when %s is required", async (role, requiredRole) => {
    const { auth } = signInWithMembership({ data: { role }, error: null });

    expect(await requireProjectRole(projectId, requiredRole)).toEqual({ ...auth, role });
  });

  it("returns 403 for a member when owner is required", async () => {
    signInWithMembership({ data: { role: "member" }, error: null });
    await expectError(
      await requireProjectRole(projectId, "owner"),
      403,
      "Project owner role required",
    );
  });

  it("returns 500 when the lookup fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const failure = { code: "XX000", message: "database unavailable" };
    signInWithMembership({ data: null, error: failure });

    await expectError(
      await requireProjectRole(projectId, "member"),
      500,
      "Internal server error",
    );
    expect(log).toHaveBeenCalledWith("Failed to load project role", failure);
  });
});
