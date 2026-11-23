import { requireProjectRole } from "@/lib/api/auth";
import { isUuid } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

type Context = { params: Promise<{ projectId: string; userId: string }> };

// Removes a member from the project. Only owners can remove members. The
// remove_project_member database function checks the role again and refuses
// to remove the last owner.
export async function DELETE(_request: Request, { params }: Context) {
  const { projectId, userId } = await params;

  const access = await requireProjectRole(projectId, "owner");
  if (access instanceof Response) return access;

  if (!isUuid(userId)) return errorResponse(400, "Invalid user ID");

  const { error } = await access.supabase.rpc("remove_project_member", {
    p_project_id: projectId,
    p_user_id: userId,
  });

  if (error) {
    switch (error.code) {
      case "22023":
        return errorResponse(400, "Invalid user ID");
      // The caller's role changed after the check above.
      case "PT403":
        return errorResponse(403, "Project owner role required");
      // The user is not a member, or the caller left the project.
      case "PT404":
        return errorResponse(
          404,
          error.message === "Project not found"
            ? "Project not found"
            : "Project member not found",
        );
      case "PT409":
        return errorResponse(409, "Project must have at least one owner");
    }
    return internalError("Failed to remove project member", error);
  }

  return jsonResponse({ message: "Member removed" });
}
