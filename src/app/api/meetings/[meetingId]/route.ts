import { authenticate } from "@/lib/api/auth";
import { isUuid } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

// Returns one meeting. RLS hides meetings of projects the user is not a
// member of, so a missing and an inaccessible meeting both return 404.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { meetingId } = await params;
  if (!isUuid(meetingId)) return errorResponse(400, "Invalid meeting ID");

  const { data, error } = await auth.supabase
    .from("meetings")
    .select("id, project_id, title, created_by, created_at")
    .eq("id", meetingId)
    .maybeSingle();

  if (error) return internalError("Failed to load meeting", error);
  if (!data) return errorResponse(404, "Meeting not found");

  return jsonResponse(data);
}
