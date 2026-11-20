import { authenticate } from "@/lib/api/auth";
import { exceedsLength, readJsonObject } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

// Same limit as meeting file names; the database only rejects blank names.
const maxNameLength = 255;

// Lists the projects the user can see. RLS returns only projects
// where the user is a member.
export async function GET() {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { data, error } = await auth.supabase
    .from("projects")
    .select("id, name, created_by, created_at")
    .order("created_at", { ascending: false });

  if (error) return internalError("Failed to list projects", error);

  return jsonResponse({ projects: data });
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
