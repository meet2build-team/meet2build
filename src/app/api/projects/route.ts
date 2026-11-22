import { authenticate } from "@/lib/api/auth";
import { exceedsLength, readJsonObject } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

// Same limit as meeting file names; the database only rejects blank names.
const maxNameLength = 255;

// Lists the projects the user can see, with the user's role in each. RLS
// returns only projects where the user is a member; the join is limited to
// the user's own membership row, so other members' roles are never read.
export async function GET() {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.supabase
    .from("projects")
    .select("id, name, created_by, created_at, project_members!inner(role)")
    .eq("project_members.user_id", auth.user.id)
    .order("created_at", { ascending: false });

  if (error) return internalError("Failed to list projects", error);

  const projects = data.map(({ project_members, ...project }) => ({
    ...project,
    role: project_members[0].role,
  }));

  return jsonResponse({ projects });
}

// Creates a project. The create_project database function inserts the
// project and makes the caller its owner in one transaction.
export async function POST(request: Request) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const name = typeof body.name === "string" ? body.name.trim() : "";

  if (name === "") {
    return errorResponse(400, "Project name must be a nonempty string");
  }
  if (exceedsLength(name, maxNameLength)) {
    return errorResponse(
      400,
      `Project name must be at most ${maxNameLength} characters`,
    );
  }

  const { data, error } = await auth.supabase.rpc("create_project", {
    p_name: name,
  });

  // 22023: the database rejected the name.
  if (error?.code === "22023") {
    return errorResponse(400, "Project name must be a nonempty string");
  }
  if (error) return internalError("Failed to create project", error);

  return jsonResponse(data, 201);
}
