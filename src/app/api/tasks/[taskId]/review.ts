import { authenticate } from "@/lib/api/auth";
import { isUuid, readJsonObject } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

export type Context = { params: Promise<{ taskId: string }> };

// PostgreSQL INTEGER, the type of task_proposals.revision.
const maxRevision = 2_147_483_647;

// Approves or rejects the task revision the user reviewed. The body is
// { expected_revision }. The approve_task_proposal and reject_task_proposal
// database functions check membership and the revision, keep the revision
// number, return the task unchanged when it already has the status, and
// refuse to change a task locked by a Jira export.
export async function reviewTask(
  request: Request,
  { params }: Context,
  action: "approve" | "reject",
) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { taskId } = await params;
  if (!isUuid(taskId)) return errorResponse(400, "Invalid task ID");

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  if (Object.keys(body).some((key) => key !== "expected_revision")) {
    return errorResponse(400, "Request body must contain only expected_revision");
  }

  const expectedRevision = body.expected_revision;
  if (
    typeof expectedRevision !== "number" ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 1 ||
    expectedRevision > maxRevision
  ) {
    return errorResponse(400, "expected_revision must be a positive integer");
  }

  const { data, error } = await auth.supabase.rpc(`${action}_task_proposal`, {
    p_task_id: taskId,
    p_expected_revision: expectedRevision,
  });

  if (error) {
    switch (error.code) {
      // The database rejected the task ID or revision.
      case "22023":
        return errorResponse(400, "Invalid task ID or revision");
      // The session ended after the check above.
      case "42501":
        return errorResponse(401, "Unauthorized");
      // The task does not exist or the user is not a project member.
      case "PT404":
        return errorResponse(404, "Task not found");
      // The task changed after expected_revision, or a Jira export has it.
      case "PT409":
        return errorResponse(
          409,
          error.message === "Task proposal is locked by Jira export"
            ? "Task is locked by Jira export"
            : "Task revision conflict",
        );
    }
    return internalError(`Failed to ${action} task`, error);
  }

  return jsonResponse(data);
}
