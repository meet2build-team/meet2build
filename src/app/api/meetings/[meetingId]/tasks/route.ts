import { authenticate } from "@/lib/api/auth";
import { isUuid } from "@/lib/api/request";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

type Context = { params: Promise<{ meetingId: string }> };

type Task = {
  source_start: number | null;
  source_end: number | null;
  analysis_run: { transcript_version_id: string };
};

const taskColumns = [
  "id",
  "analysis_run_id",
  "title",
  "description",
  "assignee",
  "due_date",
  "source_start",
  "source_end",
  "revision",
  "review_status",
  "created_at",
  "analysis_run:analysis_runs!inner(id, transcript_version_id, model, created_at," +
    " transcript_version:transcript_versions!inner(id, version_number))",
].join(", ");

// Lists the task proposals of a meeting, newest analysis run first. Each task
// includes its analysis run, the transcript version that run analysed, and
// source_excerpt: the text from source_start to source_end in that version,
// or null when the analysis could not verify the source.
// ?analysis_run_id= limits the list to one analysis run of the meeting.
//
// RLS hides meetings of projects the user is not a member of, so a missing
// and an inaccessible meeting both return 404.
export async function GET(request: Request, { params }: Context) {
  const auth = await authenticate();
  if (auth instanceof Response) return auth;

  const { meetingId } = await params;
  if (!isUuid(meetingId)) return errorResponse(400, "Invalid meeting ID");

  const runId = new URL(request.url).searchParams.get("analysis_run_id");
  if (runId !== null && !isUuid(runId)) {
    return errorResponse(400, "Invalid analysis run ID");
  }

  const meeting = await auth.supabase
    .from("meetings")
    .select("id")
    .eq("id", meetingId)
    .maybeSingle();

  if (meeting.error) return internalError("Failed to load meeting", meeting.error);
  if (!meeting.data) return errorResponse(404, "Meeting not found");

  if (runId !== null) {
    const run = await auth.supabase
      .from("analysis_runs")
      .select("id, transcript_versions!inner(meeting_id)")
      .eq("id", runId)
      .eq("transcript_versions.meeting_id", meetingId)
      .maybeSingle();

    if (run.error) return internalError("Failed to load analysis run", run.error);
    if (!run.data) return errorResponse(404, "Analysis run not found");
  }

  let query = auth.supabase
    .from("task_proposals")
    .select(taskColumns)
    .eq("analysis_run.transcript_version.meeting_id", meetingId);
  if (runId !== null) query = query.eq("analysis_run_id", runId);

  // Proposals of one run share created_at, so the ID keeps the order stable.
  const result = await query
    .order("created_at", { ascending: false })
    .order("analysis_run_id")
    .order("id");

  if (result.error) return internalError("Failed to list tasks", result.error);
  const tasks = result.data as unknown as Task[];

  // Load each analysed transcript text once, and only for verified sources.
  const versionIds = [
    ...new Set(
      tasks
        .filter((task) => task.source_start !== null)
        .map((task) => task.analysis_run.transcript_version_id),
    ),
  ];
  const texts = new Map<string, string[]>();

  if (versionIds.length > 0) {
    const versions = await auth.supabase
      .from("transcript_versions")
      .select("id, full_text")
      .in("id", versionIds);

    if (versions.error) {
      return internalError("Failed to load transcript versions", versions.error);
    }
    // The database counts source offsets in characters (code points).
    for (const version of versions.data) {
      texts.set(version.id, Array.from(version.full_text as string));
    }
  }

  return jsonResponse({
    tasks: tasks.map((task) => {
      const text = texts.get(task.analysis_run.transcript_version_id);
      const excerpt =
        text && task.source_start !== null && task.source_end !== null
          ? text.slice(task.source_start, task.source_end).join("")
          : null;
      return { ...task, source_excerpt: excerpt };
    }),
  });
}
