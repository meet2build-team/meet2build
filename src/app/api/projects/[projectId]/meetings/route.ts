import { authenticate } from "@/lib/api/auth";
import { exceedsLength, isUuid, readJsonObject } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

// Same limit as project names; the database only rejects blank titles.
const maxTitleLength = 255;

type Context = { params: Promise<{ projectId: string }> };

// Lists the meetings of a project. RLS hides projects the user is not a
// member of, so a missing and an inaccessible project both return 404.
export async function GET(_request: Request, { params }: Context) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { projectId } = await params;
  if (!isUuid(projectId)) return errorResponse(400, "Invalid project ID");

  const project = await auth.supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();

  if (project.error) return internalError("Failed to load project", project.error);
  if (!project.data) return errorResponse(404, "Project not found");

  const { data, error } = await auth.supabase
    .from("meetings")
    .select("id, project_id, title, created_by, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) return internalError("Failed to list meetings", error);

  return jsonResponse({ meetings: data });
}

// Creates a meeting. The create_meeting database function checks that the
// caller is a member of the project before inserting.
export async function POST(request: Request, { params }: Context) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { projectId } = await params;
  if (!isUuid(projectId)) return errorResponse(400, "Invalid project ID");

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const title = typeof body.title === "string" ? body.title.trim() : "";

  if (title === "") {
    return errorResponse(400, "Meeting title must be a nonempty string");
  }
  if (exceedsLength(title, maxTitleLength)) {
    return errorResponse(
      400,
      `Meeting title must be at most ${maxTitleLength} characters`,
    );
  }

  const { data, error } = await auth.supabase.rpc("create_meeting", {
    p_project_id: projectId,
    p_title: title,
  });

  // 42501: the project does not exist or the user is not a member.
  if (error?.code === "42501") return errorResponse(404, "Project not found");
  // 22023: the database rejected the title.
  if (error?.code === "22023") {
    return errorResponse(400, "Meeting title must be a nonempty string");
  }
  if (error) return internalError("Failed to create meeting", error);

  return jsonResponse(data, 201);
}
