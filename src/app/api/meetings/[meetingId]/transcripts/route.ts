import { requireUser } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store" };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Context = { params: Promise<{ meetingId: string }> };

// Lists the saved transcript versions of a meeting, newest first.
// RLS hides meetings of projects the user is not a member of, so a missing
// and an inaccessible meeting both return 404.
export async function GET(_request: Request, { params }: Context) {
  const auth = await requireUser();

  if (!auth) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: noStore },
    );
  }

  const { meetingId } = await params;

  if (!uuidPattern.test(meetingId)) {
    return Response.json(
      { error: "Invalid meeting ID" },
      { status: 400, headers: noStore },
    );
  }

  const meeting = await auth.supabase
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .maybeSingle();

  if (meeting.error) {
    console.error("Failed to load meeting", meeting.error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  if (!meeting.data) {
    return Response.json(
      { error: "Meeting not found" },
      { status: 404, headers: noStore },
    );
  }

  const { data, error } = await auth.supabase
    .from("transcript_versions")
    .select("id, meeting_id, version_number, segment_count, created_by, created_at")
    .eq("meeting_id", meetingId)
    .order("version_number", { ascending: false });

  if (error) {
    console.error("Failed to list transcript versions", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  return Response.json({ versions: data }, { headers: noStore });
}

// Saves a new transcript version. The save_transcript database function
// checks membership, validates the segments and rejects the save with
// PT409 when expected_version_id is not the latest version.
export async function POST(request: Request, { params }: Context) {
  const auth = await requireUser();

  if (!auth) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: noStore },
    );
  }

  const { meetingId } = await params;

  if (!uuidPattern.test(meetingId)) {
    return Response.json(
      { error: "Invalid meeting ID" },
      { status: 400, headers: noStore },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Request body must be valid JSON" },
      { status: 400, headers: noStore },
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return Response.json(
      { error: "Request body must be a JSON object" },
      { status: 400, headers: noStore },
    );
  }

  const input = body as Record<string, unknown>;
  const fullText = input.full_text;
  const expectedVersionId = input.expected_version_id;
  const segments = input.segments ?? [];

  if (typeof fullText !== "string" || fullText.trim() === "") {
    return Response.json(
      { error: "full_text must be a nonempty string" },
      { status: 400, headers: noStore },
    );
  }

  // Must be sent explicitly: null for the first version, otherwise the ID
  // of the version the edit started from.
  if (
    expectedVersionId !== null &&
    (typeof expectedVersionId !== "string" ||
      !uuidPattern.test(expectedVersionId))
  ) {
    return Response.json(
      { error: "expected_version_id must be a UUID or null" },
      { status: 400, headers: noStore },
    );
  }

  if (!Array.isArray(segments)) {
    return Response.json(
      { error: "segments must be an array" },
      { status: 400, headers: noStore },
    );
  }

  // The text is passed unchanged: segments must reconstruct full_text exactly.
  const { data, error } = await auth.supabase.rpc("save_transcript", {
    p_meeting_id: meetingId,
    p_expected_version_id: expectedVersionId,
    p_full_text: fullText,
    p_segments: segments,
  });

  if (error) {
    // 42501: the meeting does not exist or the user is not a member.
    if (error.code === "42501") {
      return Response.json(
        { error: "Meeting not found" },
        { status: 404, headers: noStore },
      );
    }

    // 22023: the database rejected the transcript or its segments.
    if (error.code === "22023") {
      return Response.json(
        { error: "Invalid transcript data" },
        { status: 400, headers: noStore },
      );
    }

    // PT409: another version was saved after expected_version_id.
    if (error.code === "PT409") {
      return Response.json(
        { error: "Transcript version conflict" },
        { status: 409, headers: noStore },
      );
    }

    console.error("Failed to save transcript", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  return Response.json(data, { status: 201, headers: noStore });
}
