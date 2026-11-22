import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getProject } from "@/app/api/projects/[projectId]/route";
import { GET as listProjects } from "@/app/api/projects/route";
import { requireUser } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));

type Auth = Awaited<ReturnType<typeof requireUser>>;
type Result = { data: unknown; error: unknown };

const userId = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const projectId = "0b9c2b0e-4f1a-4c3e-9d2a-7f6e5d4c3b2a";
const otherProjectId = "1c8d3a1f-5e2b-4d4f-8e3b-6a5f4e3d2c1b";
const project = {
  id: projectId,
  name: "Demo",
  created_by: userId,
  created_at: "2026-11-22T10:00:00Z",
};

// Signs in a user whose client answers each table with its own result.
function signIn(results: Record<string, Result>) {
  const queries: Record<string, ReturnType<typeof createQuery>> = {};

  function createQuery(result: Result) {
    const query = {
      select: vi.fn((): typeof query => query),
      eq: vi.fn((): typeof query => query),
      order: vi.fn(async () => result),
      maybeSingle: vi.fn(async () => result),
    };
    return query;
  }

  const supabase = {
    from: vi.fn((table: string) => {
      queries[table] = createQuery(results[table] ?? { data: null, error: null });
      return queries[table];
    }),
  };

  vi.mocked(requireUser).mockResolvedValue({
    user: { id: userId },
    supabase,
  } as unknown as Auth);

  return { supabase, queries };
}

function context(id: string) {
  return { params: Promise.resolve({ projectId: id }) };
}

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(body);
}

const request = new Request("http://localhost/api/projects");

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/projects", () => {
  it("returns 401 without a session", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectJson(await listProjects(), 401, { error: "Unauthorized" });
  });

  it("returns the user's role in each project, newest first", async () => {
    const other = { ...project, id: otherProjectId, name: "Older" };
    const { queries } = signIn({
      projects: {
        data: [
          { ...project, project_members: [{ role: "owner" }] },
          { ...other, project_members: [{ role: "member" }] },
        ],
        error: null,
      },
    });

    await expectJson(await listProjects(), 200, {
      projects: [
        { ...project, role: "owner" },
        { ...other, role: "member" },
      ],
    });

    const query = queries.projects;
    expect(query.select).toHaveBeenCalledWith(
      "id, name, created_by, created_at, project_members!inner(role)",
    );
    // Only the signed-in user's membership row is joined.
    expect(query.eq).toHaveBeenCalledWith("project_members.user_id", userId);
    expect(query.order).toHaveBeenCalledWith("created_at", { ascending: false });
  });

  it("returns an empty list when the user has no projects", async () => {
    signIn({ projects: { data: [], error: null } });
    await expectJson(await listProjects(), 200, { projects: [] });
  });

  it("returns 500 when the query fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    signIn({ projects: { data: null, error: { code: "XX000" } } });

    await expectJson(await listProjects(), 500, { error: "Internal server error" });
  });
});

describe("GET /api/projects/{projectId}", () => {
  it("returns 401 without a session", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectJson(await getProject(request, context(projectId)), 401, {
      error: "Unauthorized",
    });
  });

  it("returns 400 for an invalid project ID", async () => {
    const { supabase } = signIn({});

    await expectJson(await getProject(request, context("abc")), 400, {
      error: "Invalid project ID",
    });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it.each(["owner", "member"])("returns the project with the role %s", async (role) => {
    const { queries } = signIn({
      project_members: { data: { role }, error: null },
      projects: { data: project, error: null },
    });

    await expectJson(await getProject(request, context(projectId)), 200, {
      ...project,
      role,
    });
    expect(queries.project_members.eq).toHaveBeenCalledWith("user_id", userId);
    expect(queries.projects.eq).toHaveBeenCalledWith("id", projectId);
  });

  it("returns 404 for a missing project or a non-member", async () => {
    const { supabase } = signIn({ project_members: { data: null, error: null } });

    await expectJson(await getProject(request, context(projectId)), 404, {
      error: "Project not found",
    });
    expect(supabase.from).not.toHaveBeenCalledWith("projects");
  });

  it("returns 404 if the project row is not visible", async () => {
    signIn({
      project_members: { data: { role: "owner" }, error: null },
      projects: { data: null, error: null },
    });

    await expectJson(await getProject(request, context(projectId)), 404, {
      error: "Project not found",
    });
  });

  it.each(["project_members", "projects"])(
    "returns 500 when the %s query fails",
    async (table) => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      signIn({
        project_members: { data: { role: "owner" }, error: null },
        projects: { data: project, error: null },
        [table]: { data: null, error: { code: "XX000" } },
      });

      await expectJson(await getProject(request, context(projectId)), 500, {
        error: "Internal server error",
      });
    },
  );
});
