import { authenticate } from "@/lib/api/auth";
import { isUuid, readJsonObject } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

type Context = { params: Promise<{ taskId: string }> };

const editableFields = ["title", "description", "assignee", "due_date"];
const allowedFields = new Set(["expected_revision", ...editableFields]);

// PostgreSQL INTEGER, the type of task_proposals.revision.
const maxRevision = 2_147_483_647;

// A real calendar date in YYYY-MM-DD form. PostgreSQL has no year 0.
function isDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "0001-01-01") return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// Edits a task proposal. The body has expected_revision, the revision the
// edit started from, and any of title, description, assignee and due_date.
// Omitted fields keep their values; description, assignee and due_date can
// be cleared with null.
//
// The update_task_proposal database function checks membership and the
// revision, increments the revision, returns an approved task to
// pending_review and refuses changes to tasks locked by a Jira export.
export async function PATCH(request: Request, { params }: Context) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { taskId } = await params;
  if (!isUuid(taskId)) return errorResponse(400, "Invalid task ID");

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  // The status, revision, analysis run and source are set by the database.
  if (Object.keys(body).some((key) => !allowedFields.has(key))) {
    return errorResponse(
      400,
      "Only title, description, assignee and due_date can be edited",
    );
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

  const { title, description, assignee, due_date: dueDate } = body;

  if (title !== undefined && (typeof title !== "string" || title.trim() === "")) {
    return errorResponse(400, "title must be a nonempty string");
  }
  if (description !== undefined && description !== null && typeof description !== "string") {
    return errorResponse(400, "description must be a string or null");
  }
  if (assignee !== undefined && assignee !== null && typeof assignee !== "string") {
    return errorResponse(400, "assignee must be a string or null");
  }
  if (
    dueDate !== undefined &&
    dueDate !== null &&
    (typeof dueDate !== "string" || !isDate(dueDate))
  ) {
    return errorResponse(400, "due_date must be a valid YYYY-MM-DD date or null");
  }

  const edits: Record<string, unknown> = {};
  for (const field of editableFields) {
    if (body[field] !== undefined) edits[field] = body[field];
  }
  if (typeof title === "string") edits.title = title.trim();

  if (Object.keys(edits).length === 0) {
    return errorResponse(
      400,
      "At least one of title, description, assignee or due_date is required",
    );
  }

  // The database function replaces all four fields, so omitted ones are
  // filled in from the revision the edit started from. A task at another
  // revision would mix in values the client has not seen, so that is a
  // conflict; the database checks the revision again when saving.
  let task = edits;
  if (Object.keys(edits).length < editableFields.length) {
    const current = await auth.supabase
      .from("task_proposals")
      .select("title, description, assignee, due_date, revision")
      .eq("id", taskId)
      .maybeSingle();

    if (current.error) return internalError("Failed to load task", current.error);
    if (!current.data) return errorResponse(404, "Task not found");

    const { revision, ...values } = current.data;
    if (revision !== expectedRevision) {
      return errorResponse(409, "Task revision conflict");
    }
    task = { ...values, ...edits };
  }

  const { data, error } = await auth.supabase.rpc("update_task_proposal", {
    p_task_id: taskId,
    p_expected_revision: expectedRevision,
    p_title: task.title,
    p_description: task.description,
    p_assignee: task.assignee,
    p_due_date: task.due_date,
  });

  if (error) {
    switch (error.code) {
      // The database rejected a field value.
      case "22023":
        return errorResponse(400, "Invalid task data");
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
    return internalError("Failed to update task", error);
  }

  return jsonResponse(data);
}
