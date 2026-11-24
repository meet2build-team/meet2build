import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as approveTask } from "@/app/api/tasks/[taskId]/approve/route";
import { POST as rejectTask } from "@/app/api/tasks/[taskId]/reject/route";
import { requireUser } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));

type Auth = Awaited<ReturnType<typeof requireUser>>;
type Result = { data: unknown; error: unknown };

const taskId = "6bc28f6e-0d7a-4c9e-9d8a-1f0e9d8c7b6a";

function reviewed(status: string) {
  return {
    id: taskId,
    analysis_run_id: "2d7e4b2a-6f3c-4e5a-9f4c-5b4a3f2e1d0c",
    title: "Write docs",
    description: null,
    assignee: "Ana",
    due_date: "2026-12-01",
    source_start: null,
    source_end: null,
    revision: 2,
    review_status: status,
    created_at: "2026-11-23T10:00:00Z",
  };
}

// Signs in a user whose review database function returns `rpcResult`.
function signIn(rpcResult: Result = { data: null, error: null }) {
  const supabase = { from: vi.fn(), rpc: vi.fn(async () => rpcResult) };

  vi.mocked(requireUser).mockResolvedValue({
    user: { id: "9f8e7d6c-5b4a-4321-8fed-cba987654321" },
    supabase,
  } as unknown as Auth);

  return supabase;
}

function post(body: unknown, { id = taskId, contentType = "application/json" } = {}) {
  return {
    request: new Request(`http://localhost/api/tasks/${id}/review`, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    context: { params: Promise.resolve({ taskId: id }) },
  };
}

async function expectJson(response: Response, status: number, body: unknown) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual(body);
}

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each([
  ["approve", approveTask, "approved"],
  ["reject", rejectTask, "rejected"],
] as const)("POST /api/tasks/{taskId}/%s", (action, handler, status) => {
  async function send(body: unknown, options?: Parameters<typeof post>[1]) {
    const { request, context } = post(body, options);
    return handler(request, context);
  }

  it("returns 401 before reading the body", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectJson(await send("{"), 401, { error: "Unauthorized" });
  });

  it("returns 400 for an invalid task ID", async () => {
    const supabase = signIn();
    await expectJson(await send({ expected_revision: 1 }, { id: "abc" }), 400, {
      error: "Invalid task ID",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 415 for a non-JSON content type", async () => {
    const supabase = signIn();
    await expectJson(
      await send({ expected_revision: 1 }, { contentType: "text/plain" }),
      415,
      { error: "Content-Type must be application/json" },
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON and non-object bodies", async () => {
    const supabase = signIn();
    await expectJson(await send("{"), 400, { error: "Request body must be valid JSON" });
    await expectJson(await send([1]), 400, { error: "Request body must be a JSON object" });
    await expectJson(await send(null), 400, { error: "Request body must be a JSON object" });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([{}, { expected_revision: null }, ...[0, -1, 1.5, "1", true, [1], 2_147_483_648].map(
    (expected_revision) => ({ expected_revision }),
  )])("returns 400 for the body %j", async (body) => {
    const supabase = signIn();

    await expectJson(await send(body), 400, {
      error: "expected_revision must be a positive integer",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it.each([
    { review_status: "approved" },
    { revision: 3 },
    { title: "New title" },
    { task_id: taskId },
  ])("returns 400 for the unexpected field in %j", async (extra) => {
    const supabase = signIn();

    await expectJson(await send({ expected_revision: 1, ...extra }), 400, {
      error: "Request body must contain only expected_revision",
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it(`calls ${action}_task_proposal and returns the updated task`, async () => {
    const supabase = signIn({ data: reviewed(status), error: null });

    await expectJson(
      await send({ expected_revision: 2_147_483_647 }, { contentType: "application/json; charset=utf-8" }),
      200,
      reviewed(status),
    );
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith(`${action}_task_proposal`, {
      p_task_id: taskId,
      p_expected_revision: 2_147_483_647,
    });
  });

  it.each([
    ["22023", "A task ID and positive expected revision are required", 400, "Invalid task ID or revision"],
    ["42501", "Authentication required", 401, "Unauthorized"],
    ["PT404", "Task proposal not found", 404, "Task not found"],
    ["PT409", "Task proposal revision conflict", 409, "Task revision conflict"],
    ["PT409", "Task proposal is locked by Jira export", 409, "Task is locked by Jira export"],
  ])("maps database error %s (%s) to %i", async (code, message, httpStatus, error) => {
    signIn({ data: null, error: { code, message } });
    await expectJson(await send({ expected_revision: 1 }), httpStatus, { error });
  });

  it.each(["XX000", "0A000"])("returns a generic 500 for database error %s", async (code) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    signIn({ data: null, error: { code, message: "secret detail" } });

    await expectJson(await send({ expected_revision: 1 }), 500, {
      error: "Internal server error",
    });
    expect(log).toHaveBeenCalledWith(
      `Failed to ${action} task`,
      expect.objectContaining({ code }),
    );
  });
});
