import { requireUser } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store" };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns one transcript version of a meeting with its segments in order.
// RLS hides versions of meetings the user cannot see, so a missing version,
// a version of another meeting and an inaccessible one all return 404.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ meetingId: string; versionId: string }> },
) {
  const auth = await requireUser();

  if (!auth) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: noStore },
    );
  }

  const { meetingId, versionId } = await params;

  if (!uuidPattern.test(meetingId) || !uuidPattern.test(versionId)) {
    return Response.json(
      { error: "Invalid meeting or version ID" },
      { status: 400, headers: noStore },
    );
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
    console.error("Failed to load transcript version", version.error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  if (!version.data) {
    return Response.json(
      { error: "Transcript version not found" },
      { status: 404, headers: noStore },
    );
  }

  const { data, error } = await auth.supabase
    .from("transcript_segments")
    .select("position, text, start_ms, end_ms, speaker_id")
    .eq("version_id", versionId)
    .order("position", { ascending: true });

  if (error) {
    console.error("Failed to load transcript segments", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  return Response.json(
    { version: version.data, segments: data },
    { headers: noStore },
  );
}
