import { requireUser } from "@/lib/auth";

const noStore = { "Cache-Control": "private, no-store" };

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns one meeting. RLS hides meetings of projects the user is not a
// member of, so a missing and an inaccessible meeting both return 404.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ meetingId: string }> },
) {
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

  const { data, error } = await auth.supabase
    .from("meetings")
    .select("id, project_id, title, created_by, created_at")
    .eq("id", meetingId)
    .maybeSingle();

  if (error) {
    console.error("Failed to load meeting", error);
    return Response.json(
      { error: "Internal server error" },
      { status: 500, headers: noStore },
    );
  }

  if (!data) {
    return Response.json(
      { error: "Meeting not found" },
      { status: 404, headers: noStore },
    );
  }

  return Response.json(data, { headers: noStore });
}
