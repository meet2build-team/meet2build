import { authenticate } from "@/lib/api/auth";
import { isUuid } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

// Returns one project. RLS hides projects the user is not a member of,
// so a missing and an inaccessible project both return 404.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { projectId } = await params;
  if (!isUuid(projectId)) return errorResponse(400, "Invalid project ID");

  const { data, error } = await auth.supabase
    .from("projects")
    .select("id, name, created_by, created_at")
    .eq("id", projectId)
    .maybeSingle();

  if (error) return internalError("Failed to load project", error);
  if (!data) return errorResponse(404, "Project not found");

  return jsonResponse(data);
}
