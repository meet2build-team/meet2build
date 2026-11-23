import { requireProjectRole } from "@/lib/api/auth";
import { isEmailAddress, readJsonObject } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

type Context = { params: Promise<{ projectId: string }> };

// Lists the members of a project, ordered by when they joined. Owners and
// members can both see the list; non-members get 404.
export async function GET(_request: Request, { params }: Context) {
  const { projectId } = await params;

  const access = await requireProjectRole(projectId, "member");
  if (access instanceof Response) return access;

  const { data, error } = await access.supabase.rpc("list_project_members", {
    p_project_id: projectId,
  });

  // PT404: the user stopped being a member after the role check.
  if (error?.code === "PT404") return errorResponse(404, "Project not found");
  if (error) return internalError("Failed to list project members", error);

  return jsonResponse({ members: data });
}

// Adds a registered user to the project by email. Only owners can add
// members. The add_project_member database function checks the role again
// and inserts the row in one transaction.
export async function POST(request: Request, { params }: Context) {
  const { projectId } = await params;

  const access = await requireProjectRole(projectId, "owner");
  if (access instanceof Response) return access;

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const role = body.role;

  if (!isEmailAddress(email)) {
    return errorResponse(400, "Invalid email address");
  }
  if (role !== "owner" && role !== "member") {
    return errorResponse(400, 'Role must be "owner" or "member"');
  }

  const { data, error } = await access.supabase.rpc("add_project_member", {
    p_project_id: projectId,
    p_email: email,
    p_role: role,
  });

  if (error) {
    switch (error.code) {
      // The database rejected the email or role.
      case "22023":
        return errorResponse(400, "Invalid email address or role");
      // The caller's role changed after the check above.
      case "PT403":
        return errorResponse(403, "Project owner role required");
      // No registered user has this email, or the caller left the project.
      case "PT404":
        return errorResponse(
          404,
          error.message === "Project not found"
            ? "Project not found"
            : "User not found",
        );
      case "PT409":
        return errorResponse(409, "User is already a project member");
    }
    return internalError("Failed to add project member", error);
  }

  return jsonResponse(data, 201);
}
