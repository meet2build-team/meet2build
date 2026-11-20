import { authenticate } from "@/lib/api/auth";
import { isUuid } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

// Returns one transcript version of a meeting with its segments in order.
// RLS hides versions of meetings the user cannot see, so a missing version,
// a version of another meeting and an inaccessible one all return 404.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ meetingId: string; versionId: string }> },
) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { meetingId, versionId } = await params;
  if (!isUuid(meetingId) || !isUuid(versionId)) {
    return errorResponse(400, "Invalid meeting or version ID");
  }

  const version = await auth.supabase
    .from("transcript_versions")
    .select(
      "id, meeting_id, version_number, full_text, segment_count, created_by, created_at",
    )
    .eq("id", versionId)
    .eq("meeting_id", meetingId)
    .maybeSingle();

  if (version.error) {
    return internalError("Failed to load transcript version", version.error);
  }
  if (!version.data) return errorResponse(404, "Transcript version not found");

  const { data, error } = await auth.supabase
    .from("transcript_segments")
    .select("position, text, start_ms, end_ms, speaker_id")
    .eq("version_id", versionId)
    .order("position", { ascending: true });

  if (error) return internalError("Failed to load transcript segments", error);

  return jsonResponse({ version: version.data, segments: data });
}
