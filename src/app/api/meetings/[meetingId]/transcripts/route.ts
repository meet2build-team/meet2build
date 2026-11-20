import { authenticate } from "@/lib/api/auth";
import { exceedsLength, isUuid, readJsonObject } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

// Far above what a 25 MB recording produces, while a request carrying both
// full_text and its segments stays under typical 4.5 MB body limits.
const maxTranscriptLength = 500_000;

type Context = { params: Promise<{ meetingId: string }> };

// Lists the saved transcript versions of a meeting, newest first.
// RLS hides meetings of projects the user is not a member of, so a missing
// and an inaccessible meeting both return 404.
export async function GET(_request: Request, { params }: Context) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { meetingId } = await params;
  if (!isUuid(meetingId)) return errorResponse(400, "Invalid meeting ID");

  const meeting = await auth.supabase
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .maybeSingle();

  if (meeting.error) return internalError("Failed to load meeting", meeting.error);
  if (!meeting.data) return errorResponse(404, "Meeting not found");

  const { data, error } = await auth.supabase
    .from("transcript_versions")
    .select("id, meeting_id, version_number, segment_count, created_by, created_at")
    .eq("meeting_id", meetingId)
    .order("version_number", { ascending: false });

  if (error) return internalError("Failed to list transcript versions", error);

  return jsonResponse({ versions: data });
}

// Saves a new transcript version. The save_transcript database function
// checks membership, validates the segments and rejects the save with
// PT409 when expected_version_id is not the latest version.
export async function POST(request: Request, { params }: Context) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { meetingId } = await params;
  if (!isUuid(meetingId)) return errorResponse(400, "Invalid meeting ID");

  const body = await readJsonObject(request);
  if (body instanceof Response) return body;

  const fullText = body.full_text;
  const expectedVersionId = body.expected_version_id;
  const segments = body.segments ?? [];

  if (typeof fullText !== "string" || fullText.trim() === "") {
    return errorResponse(400, "full_text must be a nonempty string");
  }
  if (exceedsLength(fullText, maxTranscriptLength)) {
    return errorResponse(
      400,
      `full_text must be at most ${maxTranscriptLength} characters`,
    );
  }

  // Must be sent explicitly: null for the first version, otherwise the ID
  // of the version the edit started from.
  if (expectedVersionId !== null && !isUuid(expectedVersionId)) {
    return errorResponse(400, "expected_version_id must be a UUID or null");
  }

  if (!Array.isArray(segments)) {
    return errorResponse(400, "segments must be an array");
  }

  // The text is passed unchanged: segments must reconstruct full_text exactly.
  const { data, error } = await auth.supabase.rpc("save_transcript", {
    p_meeting_id: meetingId,
    p_expected_version_id: expectedVersionId,
    p_full_text: fullText,
    p_segments: segments,
  });

  // 42501: the meeting does not exist or the user is not a member.
  if (error?.code === "42501") return errorResponse(404, "Meeting not found");
  // 22023: the database rejected the transcript or its segments.
  if (error?.code === "22023") return errorResponse(400, "Invalid transcript data");
  // PT409: another version was saved after expected_version_id.
  if (error?.code === "PT409") {
    return errorResponse(409, "Transcript version conflict");
  }
  if (error) return internalError("Failed to save transcript", error);

  return jsonResponse(data, 201);
}
