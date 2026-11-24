import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as listTasks } from "@/app/api/meetings/[meetingId]/tasks/route";
import { requireUser } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));

type Auth = Awaited<ReturnType<typeof requireUser>>;
type Result = { data: unknown; error: unknown };

const meetingId = "1c8d3a1f-5e2b-4d4f-8e3b-6a5f4e3d2c1b";
const runA = "2d7e4b2a-6f3c-4e5a-9f4c-5b4a3f2e1d0c";
const runB = "3e9f5c3b-7a4d-4f6b-8a5d-4c3b2a1f0e9d";
const version1 = "4fa06d4c-8b5e-4a7c-9b6e-3d2c1b0a9f8e";
const version2 = "5ab17e5d-9c6f-4b8d-8c7f-2e1d0c9b8a7f";

function createQuery(result: Result) {
  const query = {
    select: vi.fn((): typeof query => query),
    eq: vi.fn((): typeof query => query),
    in: vi.fn((): typeof query => query),
    order: vi.fn((): typeof query => query),
    maybeSingle: vi.fn(async () => result),
    then(resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return query;
}

// Signs in a user whose client answers each table with its own result.
// The meeting is visible unless `meetings` says otherwise.
function signIn(results: Record<string, Result> = {}) {
  const queries: Record<string, ReturnType<typeof createQuery>> = {};
  const supabase = {
    from: vi.fn((table: string) => {
      const fallback = table === "meetings" ? { id: meetingId } : null;
      queries[table] = createQuery(results[table] ?? { data: fallback, error: null });
      return queries[table];
    }),
    rpc: vi.fn(),
  };

  vi.mocked(requireUser).mockResolvedValue({
    user: { id: "9f8e7d6c-5b4a-4321-8fed-cba987654321" },
    supabase,
  } as unknown as Auth);

  return { supabase, queries };
}

function run(id: string, versionId: string, versionNumber: number) {
  return {
    id,
    transcript_version_id: versionId,
    model: "model",
    created_at: "2026-11-23T10:00:00Z",
    transcript_version: { id: versionId, version_number: versionNumber },
  };
}

function task(
  id: string,
  analysisRun: ReturnType<typeof run>,
  source: [number, number] | null,
) {
  return {
    id,
    analysis_run_id: analysisRun.id,
    title: `Task ${id}`,
    description: null,
    assignee: "Ana",
    due_date: "2026-12-01",
    source_start: source?.[0] ?? null,
    source_end: source?.[1] ?? null,
    revision: 1,
    review_status: "pending_review",
    created_at: "2026-11-23T10:00:00Z",
    analysis_run: analysisRun,
  };
}

function list(id = meetingId, query = "") {
  return listTasks(new Request(`http://localhost/api/meetings/${id}/tasks${query}`), {
    params: Promise.resolve({ meetingId: id }),
  });
}

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(body);
}

const ok = (data: unknown): Result => ({ data, error: null });
const failure: Result = { data: null, error: { code: "XX000", message: "secret detail" } };

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/meetings/{meetingId}/tasks", () => {
  it("returns 401 without a session", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectJson(await list(), 401, { error: "Unauthorized" });
  });

  it("returns 400 for an invalid meeting ID", async () => {
    const { supabase } = signIn();
    await expectJson(await list("abc"), 400, { error: "Invalid meeting ID" });
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it.each(["?analysis_run_id=", "?analysis_run_id=abc"])(
    "returns 400 for an invalid analysis run ID: %s",
    async (query) => {
      const { supabase } = signIn();
      await expectJson(await list(meetingId, query), 400, {
        error: "Invalid analysis run ID",
      });
      expect(supabase.from).not.toHaveBeenCalled();
    },
  );

  it("returns 404 when the meeting is missing or hidden by RLS", async () => {
    const { supabase } = signIn({ meetings: ok(null) });

    await expectJson(await list(), 404, { error: "Meeting not found" });
    expect(supabase.from).toHaveBeenCalledTimes(1);
  });

  it("returns an empty list for a meeting without task proposals", async () => {
    const { supabase } = signIn({ task_proposals: ok([]) });

    await expectJson(await list(), 200, { tasks: [] });
    expect(supabase.from).not.toHaveBeenCalledWith("transcript_versions");
  });

  it("lists the proposals of every run with the transcript version each run analysed", async () => {
    const a = run(runA, version1, 1);
    const b = run(runB, version2, 2);
    const tasks = [
      task("t1", b, [0, 3]),
      task("t2", a, [3, 8]),
      task("t3", a, null),
    ];
    const { queries } = signIn({
      task_proposals: ok(tasks),
      transcript_versions: ok([
        // 👋 is one character but two UTF-16 code units.
        { id: version1, full_text: "Hi 👋 Ana writes docs" },
        { id: version2, full_text: "Bo fixes login" },
      ]),
    });

    await expectJson(await list(), 200, {
      tasks: [
        { ...tasks[0], source_excerpt: "Bo " },
        { ...tasks[1], source_excerpt: "👋 Ana" },
        { ...tasks[2], source_excerpt: null },
      ],
    });

    const proposals = queries.task_proposals;
    expect(proposals.select).toHaveBeenCalledWith(
      expect.stringContaining(
        "analysis_run:analysis_runs!inner(id, transcript_version_id, model, created_at," +
          " transcript_version:transcript_versions!inner(id, version_number))",
      ),
    );
    expect(proposals.eq).toHaveBeenCalledTimes(1);
    expect(proposals.eq).toHaveBeenCalledWith(
      "analysis_run.transcript_version.meeting_id",
      meetingId,
    );
    expect(proposals.order.mock.calls).toEqual([
      ["created_at", { ascending: false }],
      ["analysis_run_id"],
      ["id"],
    ]);
    // One query loads both analysed versions, never the meeting's latest one.
    expect(queries.transcript_versions.in).toHaveBeenCalledWith("id", [version2, version1]);
  });

  it("does not load transcript text when no proposal has a verified source", async () => {
    const a = run(runA, version1, 1);
    const tasks = [task("t1", a, null), task("t2", a, null)];
    const { supabase } = signIn({ task_proposals: ok(tasks) });

    await expectJson(await list(), 200, {
      tasks: tasks.map((t) => ({ ...t, source_excerpt: null })),
    });
    expect(supabase.from).not.toHaveBeenCalledWith("transcript_versions");
  });

  it("filters by an analysis run of the meeting", async () => {
    const a = run(runA, version1, 1);
    const tasks = [task("t1", a, null)];
    const { queries } = signIn({
      analysis_runs: ok({ id: runA }),
      task_proposals: ok(tasks),
    });

    await expectJson(await list(meetingId, `?analysis_run_id=${runA}`), 200, {
      tasks: [{ ...tasks[0], source_excerpt: null }],
    });
    expect(queries.analysis_runs.select).toHaveBeenCalledWith(
      "id, transcript_versions!inner(meeting_id)",
    );
    expect(queries.analysis_runs.eq).toHaveBeenCalledWith("id", runA);
    expect(queries.analysis_runs.eq).toHaveBeenCalledWith(
      "transcript_versions.meeting_id",
      meetingId,
    );
    expect(queries.task_proposals.eq).toHaveBeenCalledWith("analysis_run_id", runA);
  });

  it("returns 404 for an analysis run of another meeting or a missing run", async () => {
    const { supabase } = signIn({ analysis_runs: ok(null) });

    await expectJson(await list(meetingId, `?analysis_run_id=${runB}`), 404, {
      error: "Analysis run not found",
    });
    expect(supabase.from).not.toHaveBeenCalledWith("task_proposals");
  });

  it.each([
    ["meetings", "Failed to load meeting", ""],
    ["analysis_runs", "Failed to load analysis run", `?analysis_run_id=${runA}`],
    ["task_proposals", "Failed to list tasks", ""],
    ["transcript_versions", "Failed to load transcript versions", ""],
  ])("returns a generic 500 when the %s query fails", async (table, message, query) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    signIn({
      analysis_runs: ok({ id: runA }),
      task_proposals: ok([task("t1", run(runA, version1, 1), [0, 1])]),
      [table]: failure,
    });

    await expectJson(await list(meetingId, query), 500, { error: "Internal server error" });
    expect(log).toHaveBeenCalledWith(message, expect.objectContaining({ code: "XX000" }));
  });
});
