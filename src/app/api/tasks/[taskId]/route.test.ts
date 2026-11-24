import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PATCH as editTask } from "@/app/api/tasks/[taskId]/route";
import { requireUser } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));

type Auth = Awaited<ReturnType<typeof requireUser>>;
type Result = { data: unknown; error: unknown };

const taskId = "6bc28f6e-0d7a-4c9e-9d8a-1f0e9d8c7b6a";

const current = {
  title: "Write docs",
  description: "REST API",
  assignee: "Ana",
  due_date: "2026-12-01",
  revision: 2,
};

const saved = {
  id: taskId,
  analysis_run_id: "2d7e4b2a-6f3c-4e5a-9f4c-5b4a3f2e1d0c",
  title: "Write docs",
  description: "REST API",
  assignee: "Ana",
  due_date: "2026-12-01",
  source_start: 3,
  source_end: 8,
  revision: 3,
  review_status: "pending_review",
  created_at: "2026-11-23T10:00:00Z",
};

// Signs in a user. `task` is what reading the task returns (null when RLS
// hides it), and `rpcResult` is what update_task_proposal returns.
function signIn({
  task = { data: current, error: null },
  rpcResult = { data: saved, error: null },
}: { task?: Result; rpcResult?: Result } = {}) {
  const query = {
    select: vi.fn((): typeof query => query),
    eq: vi.fn((): typeof query => query),
    maybeSingle: vi.fn(async () => task),
  };
  const supabase = {
    from: vi.fn(() => query),
    rpc: vi.fn(async () => rpcResult),
  };

  vi.mocked(requireUser).mockResolvedValue({
    user: { id: "9f8e7d6c-5b4a-4321-8fed-cba987654321" },
    supabase,
  } as unknown as Auth);

  return { supabase, query };
}

function patch(body: unknown, { id = taskId, contentType = "application/json" } = {}) {
  return editTask(
    new Request(`http://localhost/api/tasks/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve({ taskId: id }) },
  );
}

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(body);
}

const fullEdit = {
  expected_revision: 2,
  title: "Write docs",
  description: "REST API",
  assignee: "Ana",
  due_date: "2026-12-01",
};

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PATCH /api/tasks/{taskId}", () => {
  it("returns 401 before reading the body", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectJson(await patch("{"), 401, { error: "Unauthorized" });
  });

  it("returns 400 for an invalid task ID", async () => {
    const { supabase } = signIn();
    await expectJson(await patch(fullEdit, { id: "abc" }), 400, { error: "Invalid task ID" });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 415 for a non-JSON content type", async () => {
    const { supabase } = signIn();
    await expectJson(await patch(fullEdit, { contentType: "text/plain" }), 415, {
      error: "Content-Type must be application/json",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON and non-object bodies", async () => {
    signIn();
    await expectJson(await patch("{"), 400, { error: "Request body must be valid JSON" });
    await expectJson(await patch([fullEdit]), 400, {
      error: "Request body must be a JSON object",
    });
  });

  it.each([
    "review_status",
    "revision",
    "analysis_run_id",
    "transcript_version_id",
    "source_start",
    "source_end",
    "id",
  ])("refuses to change %s", async (field) => {
    const { supabase } = signIn();

    await expectJson(await patch({ ...fullEdit, [field]: "approved" }), 400, {
      error: "Only title, description, assignee and due_date can be edited",
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([undefined, null, 0, -1, 1.5, "2", true, 2_147_483_648])(
    "returns 400 for the expected revision %j",
    async (expectedRevision) => {
      const { supabase } = signIn();

      await expectJson(
        await patch({ ...fullEdit, expected_revision: expectedRevision }),
        400,
        { error: "expected_revision must be a positive integer" },
      );
      expect(supabase.rpc).not.toHaveBeenCalled();
    },
  );

  it.each([null, "", "   ", 42, ["Title"]])("returns 400 for the title %j", async (title) => {
    const { supabase } = signIn();

    await expectJson(await patch({ ...fullEdit, title }), 400, {
      error: "title must be a nonempty string",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["description", 42, "description must be a string or null"],
    ["description", {}, "description must be a string or null"],
    ["assignee", 7, "assignee must be a string or null"],
    ["assignee", ["Ana"], "assignee must be a string or null"],
  ])("returns 400 when %s is %j", async (field, value, error) => {
    const { supabase } = signIn();

    await expectJson(await patch({ ...fullEdit, [field]: value }), 400, { error });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    "2026-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-10",
    "0000-01-01",
    "2026-1-01",
    "01.12.2026",
    "2026-12-01T00:00:00Z",
    "",
    20261201,
  ])("returns 400 for the due date %j", async (dueDate) => {
    const { supabase } = signIn();

    await expectJson(await patch({ ...fullEdit, due_date: dueDate }), 400, {
      error: "due_date must be a valid YYYY-MM-DD date or null",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 400 when no editable field is sent", async () => {
    const { supabase } = signIn();

    await expectJson(await patch({ expected_revision: 2 }), 400, {
      error: "At least one of title, description, assignee or due_date is required",
    });
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("saves a full edit directly through the database function", async () => {
    const { supabase } = signIn();

    await expectJson(
      await patch({ ...fullEdit, title: "  New title ", due_date: "2028-02-29" }),
      200,
      saved,
    );
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith("update_task_proposal", {
      p_task_id: taskId,
      p_expected_revision: 2,
      p_title: "New title",
      p_description: "REST API",
      p_assignee: "Ana",
      p_due_date: "2028-02-29",
    });
  });

  it("keeps omitted fields and clears fields sent as null", async () => {
    const { supabase, query } = signIn();

    await expectJson(
      await patch({ expected_revision: 2, assignee: null, due_date: null }),
      200,
      saved,
    );
    expect(supabase.from).toHaveBeenCalledWith("task_proposals");
    expect(query.select).toHaveBeenCalledWith(
      "title, description, assignee, due_date, revision",
    );
    expect(query.eq).toHaveBeenCalledWith("id", taskId);
    expect(supabase.rpc).toHaveBeenCalledWith("update_task_proposal", {
      p_task_id: taskId,
      p_expected_revision: 2,
      p_title: "Write docs",
      p_description: "REST API",
      p_assignee: null,
      p_due_date: null,
    });
  });

  it("returns 404 for a partial edit of a missing or hidden task", async () => {
    const { supabase } = signIn({ task: { data: null, error: null } });

    await expectJson(await patch({ expected_revision: 2, title: "New" }), 404, {
      error: "Task not found",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 409 for a partial edit started from another revision", async () => {
    const { supabase } = signIn();

    await expectJson(await patch({ expected_revision: 1, title: "New" }), 409, {
      error: "Task revision conflict",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns a generic 500 when reading the task fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    signIn({ task: { data: null, error: { code: "XX000", message: "secret detail" } } });

    await expectJson(await patch({ expected_revision: 2, title: "New" }), 500, {
      error: "Internal server error",
    });
    expect(log).toHaveBeenCalledWith(
      "Failed to load task",
      expect.objectContaining({ code: "XX000" }),
    );
  });

  it.each([
    ["22023", "Task title cannot be empty", 400, "Invalid task data"],
    ["42501", "Authentication required", 401, "Unauthorized"],
    ["PT404", "Task proposal not found", 404, "Task not found"],
    ["PT409", "Task proposal revision conflict", 409, "Task revision conflict"],
    ["PT409", "Task proposal is locked by Jira export", 409, "Task is locked by Jira export"],
  ])("maps database error %s (%s) to %i", async (code, message, status, error) => {
    signIn({ rpcResult: { data: null, error: { code, message } } });
    await expectJson(await patch(fullEdit), status, { error });
  });

  it.each(["XX000", "0A000"])("returns a generic 500 for database error %s", async (code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    signIn({ rpcResult: { data: null, error: { code, message: "secret detail" } } });

    await expectJson(await patch(fullEdit), 500, { error: "Internal server error" });
    expect(log).toHaveBeenCalledWith(
      "Failed to update task",
      expect.objectContaining({ code }),
    );
  });
});
