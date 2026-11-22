import { requireProjectRole } from "@/lib/api/auth";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

// Returns one project with the user's role in it. RLS hides projects the
// user is not a member of, so a missing and an inaccessible project both
// return 404.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const { projectId } = await params;

  const access = await requireProjectRole(projectId, "member");
  if (access instanceof Response) return access;

  const { data, error } = await access.supabase
    .from("projects")
    .select("id, name, created_by, created_at")
    .eq("id", projectId)
    .maybeSingle();

  if (error) return internalError("Failed to load project", error);
  if (!data) return errorResponse(404, "Project not found");

  return jsonResponse({ ...data, role: access.role });
}
