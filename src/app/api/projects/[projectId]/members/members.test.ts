import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE as removeMember } from "@/app/api/projects/[projectId]/members/[userId]/route";
import { GET as listMembers, POST as addMember } from "@/app/api/projects/[projectId]/members/route";
import { requireUser } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));

type Auth = Awaited<ReturnType<typeof requireUser>>;
type Result = { data: unknown; error: unknown };

const callerId = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const memberId = "3e9f5c3b-7a4d-4f6b-8a5d-4c3b2a1f0e9d";
const projectId = "0b9c2b0e-4f1a-4c3e-9d2a-7f6e5d4c3b2a";

const members = [
  { user_id: callerId, email: "owner@example.com", role: "owner", created_at: "2026-11-22T10:00:00Z" },
  { user_id: memberId, email: "member@example.com", role: "member", created_at: "2026-11-22T11:00:00Z" },
];

// Signs in the caller with the given role in the project (null for a
// non-member). `rpcResult` is what the database function returns.
function signIn(role: "owner" | "member" | null, rpcResult: Result = { data: null, error: null }) {
  const query = {
    select: vi.fn((): typeof query => query),
    eq: vi.fn((): typeof query => query),
    maybeSingle: vi.fn(async () => ({ data: role && { role }, error: null })),
  };
  const supabase = {
    from: vi.fn(() => query),
    rpc: vi.fn(async () => rpcResult),
  };

  vi.mocked(requireUser).mockResolvedValue({
    user: { id: callerId },
    supabase,
  } as unknown as Auth);

  return supabase;
}

function context(id = projectId) {
  return { params: Promise.resolve({ projectId: id }) };
}

function memberContext(id = memberId, project = projectId) {
  return { params: Promise.resolve({ projectId: project, userId: id }) };
}

function jsonPost(body: unknown) {
  return new Request("http://localhost/api/projects/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const getRequest = new Request("http://localhost/api/projects/members");
const deleteRequest = new Request("http://localhost/api/projects/members", {
  method: "DELETE",
});

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(body);
}

function dbError(code: string, message = "") {
  return { data: null, error: { code, message } };
}

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/projects/{projectId}/members", () => {
  it("returns 401 without a session", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectJson(await listMembers(getRequest, context()), 401, {
      error: "Unauthorized",
    });
  });

  it("returns 400 for an invalid project ID", async () => {
    const supabase = signIn("owner");

    await expectJson(await listMembers(getRequest, context("abc")), 400, {
      error: "Invalid project ID",
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each(["owner", "member"] as const)("lets an %s list the members in order", async (role) => {
    const supabase = signIn(role, { data: members, error: null });

    await expectJson(await listMembers(getRequest, context()), 200, { members });
    expect(supabase.rpc).toHaveBeenCalledWith("list_project_members", {
      p_project_id: projectId,
    });
  });

  it("returns 404 to a non-member without listing members", async () => {
    const supabase = signIn(null);

    await expectJson(await listMembers(getRequest, context()), 404, {
      error: "Project not found",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 404 if the database no longer sees the caller as a member", async () => {
    signIn("member", dbError("PT404", "Project not found"));

    await expectJson(await listMembers(getRequest, context()), 404, {
      error: "Project not found",
    });
  });

  it("returns a generic 500 when the database fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    signIn("member", dbError("XX000", "secret detail"));

    await expectJson(await listMembers(getRequest, context()), 500, {
      error: "Internal server error",
    });
    expect(log).toHaveBeenCalledWith(
      "Failed to list project members",
      expect.objectContaining({ code: "XX000" }),
    );
  });
});

describe("POST /api/projects/{projectId}/members", () => {
  const created = {
    project_id: projectId,
    user_id: memberId,
    role: "member",
    created_at: "2026-11-23T10:00:00Z",
  };

  it("returns 401 without a session", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectJson(
      await addMember(jsonPost({ email: "a@example.com", role: "member" }), context()),
      401,
      { error: "Unauthorized" },
    );
  });

  it("returns 400 for an invalid project ID", async () => {
    signIn("owner");
    await expectJson(
      await addMember(jsonPost({ email: "a@example.com", role: "member" }), context("abc")),
      400,
      { error: "Invalid project ID" },
    );
  });

  it.each(["owner", "member"] as const)("lets an owner add a user as %s", async (role) => {
    const supabase = signIn("owner", { data: { ...created, role }, error: null });

    await expectJson(
      await addMember(jsonPost({ email: "  member@example.com ", role }), context()),
      201,
      { ...created, role },
    );
    expect(supabase.rpc).toHaveBeenCalledWith("add_project_member", {
      p_project_id: projectId,
      p_email: "member@example.com",
      p_role: role,
    });
  });

  it("returns 403 to a member who is not an owner", async () => {
    const supabase = signIn("member");

    await expectJson(
      await addMember(jsonPost({ email: "a@example.com", role: "member" }), context()),
      403,
      { error: "Project owner role required" },
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 404 to a non-member", async () => {
    const supabase = signIn(null);

    await expectJson(
      await addMember(jsonPost({ email: "a@example.com", role: "member" }), context()),
      404,
      { error: "Project not found" },
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ role: "member" }],
    [{ email: "", role: "member" }],
    [{ email: 42, role: "member" }],
    [{ email: "not-an-email", role: "member" }],
    [{ email: "a b@example.com", role: "member" }],
    [{ email: `${"a".repeat(250)}@example.com`, role: "member" }],
  ])("returns 400 for an invalid email: %j", async (body) => {
    const supabase = signIn("owner");

    await expectJson(await addMember(jsonPost(body), context()), 400, {
      error: "Invalid email address",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    [{ email: "a@example.com" }],
    [{ email: "a@example.com", role: "" }],
    [{ email: "a@example.com", role: "admin" }],
    [{ email: "a@example.com", role: "Owner" }],
    [{ email: "a@example.com", role: ["member"] }],
  ])("returns 400 for an invalid role: %j", async (body) => {
    const supabase = signIn("owner");

    await expectJson(await addMember(jsonPost(body), context()), 400, {
      error: 'Role must be "owner" or "member"',
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    signIn("owner");
    const request = new Request("http://localhost/api/projects/members", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "email=a@example.com",
    });

    await expectJson(await addMember(request, context()), 415, {
      error: "Content-Type must be application/json",
    });
  });

  it.each([
    ["22023", "Invalid email address", 400, "Invalid email address or role"],
    ["PT403", "Project owner role required", 403, "Project owner role required"],
    ["PT404", "User not found", 404, "User not found"],
    ["PT404", "Project not found", 404, "Project not found"],
    ["PT409", "User is already a project member", 409, "User is already a project member"],
  ])("maps database error %s (%s) to %i", async (code, message, status, error) => {
    signIn("owner", dbError(code, message));

    await expectJson(
      await addMember(jsonPost({ email: "a@example.com", role: "member" }), context()),
      status,
      { error },
    );
  });

  it("returns a generic 500 when the database fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    signIn("owner", dbError("XX000", "secret detail"));

    await expectJson(
      await addMember(jsonPost({ email: "a@example.com", role: "member" }), context()),
      500,
      { error: "Internal server error" },
    );
    expect(log).toHaveBeenCalledWith(
      "Failed to add project member",
      expect.objectContaining({ code: "XX000" }),
    );
  });
});

describe("DELETE /api/projects/{projectId}/members/{userId}", () => {
  it("returns 401 without a session", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectJson(await removeMember(deleteRequest, memberContext()), 401, {
      error: "Unauthorized",
    });
  });

  it("returns 400 for an invalid project ID", async () => {
    const supabase = signIn("owner");

    await expectJson(await removeMember(deleteRequest, memberContext(memberId, "abc")), 400, {
      error: "Invalid project ID",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid user ID", async () => {
    const supabase = signIn("owner");

    await expectJson(await removeMember(deleteRequest, memberContext("abc")), 400, {
      error: "Invalid user ID",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("lets an owner remove a member", async () => {
    const supabase = signIn("owner");

    await expectJson(await removeMember(deleteRequest, memberContext()), 200, {
      message: "Member removed",
    });
    expect(supabase.rpc).toHaveBeenCalledWith("remove_project_member", {
      p_project_id: projectId,
      p_user_id: memberId,
    });
  });

  it("returns 403 to a member who is not an owner", async () => {
    const supabase = signIn("member");

    await expectJson(await removeMember(deleteRequest, memberContext()), 403, {
      error: "Project owner role required",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 404 to a non-member", async () => {
    const supabase = signIn(null);

    await expectJson(await removeMember(deleteRequest, memberContext()), 404, {
      error: "Project not found",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["22023", "User ID is required", 400, "Invalid user ID"],
    ["PT403", "Project owner role required", 403, "Project owner role required"],
    ["PT404", "Project member not found", 404, "Project member not found"],
    ["PT404", "Project not found", 404, "Project not found"],
    ["PT409", "Project must have at least one owner", 409, "Project must have at least one owner"],
  ])("maps database error %s (%s) to %i", async (code, message, status, error) => {
    signIn("owner", dbError(code, message));

    await expectJson(await removeMember(deleteRequest, memberContext()), status, { error });
  });

  it("returns a generic 500 when the database fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    signIn("owner", dbError("XX000", "secret detail"));

    await expectJson(await removeMember(deleteRequest, memberContext()), 500, {
      error: "Internal server error",
    });
    expect(log).toHaveBeenCalledWith(
      "Failed to remove project member",
      expect.objectContaining({ code: "XX000" }),
    );
  });
});
