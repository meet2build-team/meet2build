import { afterEach, describe, expect, it, vi } from "vitest";
import { errorResponse, internalError, jsonResponse } from "@/lib/api/response";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jsonResponse", () => {
  it("returns JSON that must not be cached", async () => {
    const response = jsonResponse({ ok: true }, 201);

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("defaults to status 200", () => {
    expect(jsonResponse({}).status).toBe(200);
  });
});

describe("errorResponse", () => {
  it("wraps the message in an error field", async () => {
    const response = errorResponse(404, "Project not found");

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Project not found" });
  });
});

describe("internalError", () => {
  it("logs the cause and returns a generic 500", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = { code: "XX000", message: "secret detail" };

    const response = internalError("Failed to load project", cause);

    expect(log).toHaveBeenCalledWith("Failed to load project", cause);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal server error" });
  });
});
