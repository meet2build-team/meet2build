import { type Context, reviewTask } from "@/app/api/tasks/[taskId]/review";

// Approves the task revision given in expected_revision.
export async function POST(request: Request, context: Context) {
  return reviewTask(request, context, "approve");
}
