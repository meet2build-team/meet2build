import { isUuid } from "@/lib/api/request";
import { errorResponse, internalError } from "@/lib/api/response";
import { requireUser } from "@/lib/auth";

// Returns the signed-in user and a Supabase client acting as that user,
// or a 401 response.
//
// Errors are not caught: requireUser() throws when Supabase Auth is
// unreachable (a 500, not a 401), and Next.js uses rejections from
// cookies() to control rendering, so they must reach the framework.
export async function authenticate() {
  return (await requireUser()) ?? errorResponse(401, "Unauthorized");
}

// Project permissions (SRS FR-01, FR-06):
//
// | Action                                         | Owner | Member |
// |------------------------------------------------|-------|--------|
// | View the project and its members               | yes   | yes    |
// | Meetings, transcripts, task review             | yes   | yes    |
// | Add or remove members, change roles            | yes   | no     |
// | Jira settings (not implemented yet)            | yes   | no     |
//
// Non-members get 404, so they cannot tell whether a project exists.
export type ProjectRole = "owner" | "member";

// Returns the signed-in user, the Supabase client and the user's role in the
// project, or a 401, 400, 404 or 403 response. "member" accepts owners too.
//
// The lookup runs under RLS, which shows membership rows only to members of
// the same project. The database functions that change data check the role
// again, so this check gives a clear early error rather than replacing them.
export async function requireProjectRole(
  projectId: string,
  requiredRole: ProjectRole,
) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  if (!isUuid(projectId)) return errorResponse(400, "Invalid project ID");

  const { data, error } = await auth.supabase
    .from("project_members")
    .select("role")
    .eq("project_id", projectId)
    .eq("user_id", auth.user.id)
    .maybeSingle();

  if (error) return internalError("Failed to load project role", error);
  if (!data) return errorResponse(404, "Project not found");

  const role = data.role as ProjectRole;
  if (requiredRole === "owner" && role !== "owner") {
    return errorResponse(403, "Project owner role required");
  }

  return { ...auth, role };
}
