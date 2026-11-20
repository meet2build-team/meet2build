import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as getMe } from "@/app/api/me/route";
import { GET as getMeeting } from "@/app/api/meetings/[meetingId]/route";
import { POST as saveTranscript } from "@/app/api/meetings/[meetingId]/transcripts/route";
import { GET as getTranscriptVersion } from "@/app/api/meetings/[meetingId]/transcripts/[versionId]/route";
import { GET as getProject } from "@/app/api/projects/[projectId]/route";
import { POST as createMeeting } from "@/app/api/projects/[projectId]/meetings/route";
import { POST as createProject } from "@/app/api/projects/route";
import { requireUser } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({ requireUser: vi.fn() }));

type Auth = Awaited<ReturnType<typeof requireUser>>;
type Result = { data: unknown; error: unknown };

const projectId = "0b9c2b0e-4f1a-4c3e-9d2a-7f6e5d4c3b2a";
const meetingId = "1c8d3a1f-5e2b-4d4f-8e3b-6a5f4e3d2c1b";
const versionId = "2d7e4b2a-6f3c-4e5a-9f4c-5b4a3f2e1d0c";

// Signs in a fake user whose Supabase client returns the given results.
function signIn({
  rpcResult = { data: null, error: null },
  queryResult = { data: null, error: null },
}: { rpcResult?: Result; queryResult?: Result } = {}) {
  const query = {
    select() {
      return this;
    },
    eq() {
      return this;
    },
    maybeSingle: async () => queryResult,
  };
  const supabase = {
    rpc: vi.fn().mockResolvedValue(rpcResult),
    from: vi.fn(() => query),
  };

  vi.mocked(requireUser).mockResolvedValue({
    user: { id: "user-1", email: "user@example.com" },
    supabase,
  } as unknown as Auth);

  return supabase;
}

function jsonPost(body: unknown, contentType = "application/json") {
  return new Request("http://localhost/api/test", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function context<T>(params: T) {
  return { params: Promise.resolve(params) };
}

async function expectError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.json()).toEqual({ error });
}

beforeEach(() => {
  vi.mocked(requireUser).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/me", () => {
  it("returns 401 without a session", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectError(await getMe(), 401, "Unauthorized");
  });

  it("returns the signed-in user", async () => {
    signIn();
    const response = await getMe();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      id: "user-1",
      email: "user@example.com",
    });
  });
});

describe("POST /api/projects", () => {
  it("returns 401 before reading the body", async () => {
    vi.mocked(requireUser).mockResolvedValue(null);
    await expectError(await createProject(jsonPost("{")), 401, "Unauthorized");
  });

  it("returns 415 for a non-JSON content type", async () => {
    const supabase = signIn();
    const response = await createProject(jsonPost({ name: "Demo" }, "text/plain"));

    await expectError(response, 415, "Content-Type must be application/json");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 400 for malformed JSON and non-object bodies", async () => {
    signIn();
    await expectError(
      await createProject(jsonPost("{")),
      400,
      "Request body must be valid JSON",
    );
    await expectError(
      await createProject(jsonPost(["Demo"])),
      400,
      "Request body must be a JSON object",
    );
  });

  it.each([undefined, 42, "", "   "])(
    "returns 400 for the name %j",
    async (name) => {
      signIn();
      await expectError(
        await createProject(jsonPost({ name })),
        400,
        "Project name must be a nonempty string",
      );
    },
  );

  it("returns 400 for a name longer than 255 characters", async () => {
    const supabase = signIn();
    const response = await createProject(jsonPost({ name: "a".repeat(256) }));

    await expectError(response, 400, "Project name must be at most 255 characters");
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("creates the project with the trimmed name", async () => {
    const project = { id: projectId, name: "a".repeat(255) };
    const supabase = signIn({ rpcResult: { data: project, error: null } });

    const response = await createProject(
      jsonPost({ name: ` ${"a".repeat(255)} ` }, "application/json; charset=utf-8"),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual(project);
    expect(supabase.rpc).toHaveBeenCalledWith("create_project", {
      p_name: "a".repeat(255),
    });
  });

  it("maps database errors", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});

    signIn({ rpcResult: { data: null, error: { code: "22023" } } });
    await expectError(
      await createProject(jsonPost({ name: "Demo" })),
      400,
      "Project name must be a nonempty string",
    );

    signIn({ rpcResult: { data: null, error: { code: "XX000" } } });
    await expectError(
      await createProject(jsonPost({ name: "Demo" })),
      500,
      "Internal server error",
    );
  });
});

describe("POST /api/projects/{projectId}/meetings", () => {
  it("returns 400 for an invalid project ID", async () => {
    signIn();
    await expectError(
      await createMeeting(jsonPost({ title: "Kickoff" }), context({ projectId: "abc" })),
      400,
      "Invalid project ID",
    );
  });

  it("returns 415 for a non-JSON content type", async () => {
    signIn();
    await expectError(
      await createMeeting(
        jsonPost({ title: "Kickoff" }, "multipart/form-data"),
        context({ projectId }),
      ),
      415,
      "Content-Type must be application/json",
    );
  });

  it("returns 400 for a blank or too long title", async () => {
    const supabase = signIn();

    await expectError(
      await createMeeting(jsonPost({ title: " " }), context({ projectId })),
      400,
      "Meeting title must be a nonempty string",
    );
    await expectError(
      await createMeeting(jsonPost({ title: "a".repeat(256) }), context({ projectId })),
      400,
      "Meeting title must be at most 255 characters",
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("returns 404 when the user cannot access the project", async () => {
    signIn({ rpcResult: { data: null, error: { code: "42501" } } });
    await expectError(
      await createMeeting(jsonPost({ title: "Kickoff" }), context({ projectId })),
      404,
      "Project not found",
    );
  });

  it("creates the meeting with the trimmed title", async () => {
    const meeting = { id: meetingId, title: "Kickoff" };
    const supabase = signIn({ rpcResult: { data: meeting, error: null } });

    const response = await createMeeting(
      jsonPost({ title: " Kickoff " }),
      context({ projectId }),
    );

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(meeting);
    expect(supabase.rpc).toHaveBeenCalledWith("create_meeting", {
      p_project_id: projectId,
      p_title: "Kickoff",
    });
  });
});

describe("POST /api/meetings/{meetingId}/transcripts", () => {
  const valid = { full_text: "Hello", expected_version_id: null };

  it("returns 400 for an invalid meeting ID", async () => {
    signIn();
    await expectError(
      await saveTranscript(jsonPost(valid), context({ meetingId: "abc" })),
      400,
      "Invalid meeting ID",
    );
  });

  it("returns 415 for a non-JSON content type", async () => {
    signIn();
    await expectError(
      await saveTranscript(jsonPost(valid, "text/plain"), context({ meetingId })),
      415,
      "Content-Type must be application/json",
    );
  });

  it("returns 400 for invalid fields", async () => {
    const supabase = signIn();
    const save = (body: unknown) => saveTranscript(jsonPost(body), context({ meetingId }));

    await expectError(
      await save({ ...valid, full_text: "  " }),
      400,
      "full_text must be a nonempty string",
    );
    await expectError(
      await save({ ...valid, full_text: "a".repeat(500_001) }),
      400,
      "full_text must be at most 500000 characters",
    );
    await expectError(
      await save({ full_text: "Hello" }),
      400,
      "expected_version_id must be a UUID or null",
    );
    await expectError(
      await save({ ...valid, expected_version_id: "abc" }),
      400,
      "expected_version_id must be a UUID or null",
    );
    await expectError(
      await save({ ...valid, segments: {} }),
      400,
      "segments must be an array",
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("passes the text unchanged and accepts the maximum length", async () => {
    const supabase = signIn({ rpcResult: { data: { id: versionId }, error: null } });
    const fullText = ` ${"a".repeat(499_998)} `;

    const response = await saveTranscript(
      jsonPost({ full_text: fullText, expected_version_id: versionId }),
      context({ meetingId }),
    );

    expect(response.status).toBe(201);
    expect(supabase.rpc).toHaveBeenCalledWith("save_transcript", {
      p_meeting_id: meetingId,
      p_expected_version_id: versionId,
      p_full_text: fullText,
      p_segments: [],
    });
  });

  it.each([
    ["42501", 404, "Meeting not found"],
    ["22023", 400, "Invalid transcript data"],
    ["PT409", 409, "Transcript version conflict"],
  ])("maps database error %s to %i", async (code, status, error) => {
    signIn({ rpcResult: { data: null, error: { code } } });
    await expectError(
      await saveTranscript(jsonPost(valid), context({ meetingId })),
      status,
      error,
    );
  });
});

describe("GET routes with ID parameters", () => {
  it("return 400 for invalid IDs", async () => {
    signIn();
    const request = new Request("http://localhost/api/test");

    await expectError(
      await getProject(request, context({ projectId: "abc" })),
      400,
      "Invalid project ID",
    );
    await expectError(
      await getMeeting(request, context({ meetingId: "abc" })),
      400,
      "Invalid meeting ID",
    );
    await expectError(
      await getTranscriptVersion(request, context({ meetingId, versionId: "abc" })),
      400,
      "Invalid meeting or version ID",
    );
  });

  it("return 404 when RLS hides the row", async () => {
    signIn({ queryResult: { data: null, error: null } });
    const request = new Request("http://localhost/api/test");

    await expectError(
      await getProject(request, context({ projectId })),
      404,
      "Project not found",
    );
    await expectError(
      await getMeeting(request, context({ meetingId })),
      404,
      "Meeting not found",
    );
  });
});
