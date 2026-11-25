import { normalizeTranscription } from "@/lib/audio/normalize-transcription";
import { requestGroqTranscription } from "@/lib/audio/request-groq-transcription";
import { requireUser } from "@/lib/auth";

export const maxDuration = 180;

const noStore = { "Cache-Control": "private, no-store" };
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const maxAudioBytes = 25_000_000;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

type UploadedAudio = {
  storage_path: string;
  format: "wav" | "mp3";
  size_bytes: number;
};

function isUploadedAudio(value: unknown): value is UploadedAudio {
  return (
    typeof value === "object" &&
    value !== null &&
    "storage_path" in value &&
    typeof value.storage_path === "string" &&
    value.storage_path.length > 0 &&
    "format" in value &&
    (value.format === "wav" || value.format === "mp3") &&
    "size_bytes" in value &&
    typeof value.size_bytes === "number" &&
    Number.isSafeInteger(value.size_bytes) &&
    value.size_bytes > 0
  );
}

function fail(status: number, error: string) {
  return Response.json({ error }, { status, headers: noStore });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ meetingId: string }> },
) {
  const { meetingId } = await params;
  if (!isUuid(meetingId)) {
    return fail(400, "Invalid meeting ID");
  }

  const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
  if (contentType?.toLowerCase() !== "application/json") {
    return fail(415, "Expected application/json");
  }

  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return fail(400, "Invalid request body");
  }

  const { fileId, expectedVersionId, language } = body as {
    fileId?: unknown;
    expectedVersionId?: unknown;
    language?: unknown;
  };

  if (!isUuid(fileId)) {
    return fail(400, "Invalid file ID");
  }
  if (expectedVersionId !== null && !isUuid(expectedVersionId)) {
    return fail(400, "Expected version ID must be a UUID or null");
  }
  if (
    language !== undefined &&
    (typeof language !== "string" || !/^[a-z]{2}$/.test(language))
  ) {
    return fail(400, "Invalid transcription language");
  }

  const timeoutMs = 170_000;
  const deadline = Date.now() + timeoutMs;

  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(timeoutMs),
  ]);

  try {
    const auth = await requireUser();
    if (!auth) return fail(401, "Unauthorized");

    const { supabase } = auth;
    const { data: audio, error: metadataError } = await supabase
      .rpc("get_uploaded_meeting_audio", {
        p_meeting_id: meetingId,
        p_file_id: fileId,
      })
      .abortSignal(signal)
      .maybeSingle();

    if (signal.aborted) return fail(504, "Transcription timed out");
    if (metadataError) return fail(500, "Could not load audio metadata");
    if (!audio) return fail(404, "Uploaded audio file not found");
    if (!isUploadedAudio(audio)) {
      return fail(500, "Invalid stored audio metadata");
    }
    if (audio.size_bytes > maxAudioBytes) {
      return fail(413, "Audio exceeds the 25 MB transcription limit");
    }

    const { data: current, error: currentError } = await supabase
      .from("transcript_versions")
      .select("id")
      .eq("meeting_id", meetingId)
      .order("version_number", { ascending: false })
      .limit(1)
      .abortSignal(signal)
      .maybeSingle();

    if (signal.aborted) return fail(504, "Transcription timed out");
    if (currentError) return fail(500, "Could not load current transcript version");
    if ((current?.id ?? null) !== (expectedVersionId?.toLowerCase() ?? null)) {
      return fail(409, "Transcript version conflict");
    }

    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) return fail(503, "Transcription is not configured");

    const { data: file, error: downloadError } = await supabase.storage
      .from("meeting-files")
      .download(audio.storage_path, {}, { cache: "no-store", signal });

    if (signal.aborted) return fail(504, "Transcription timed out");
    if (downloadError || !file) return fail(502, "Could not download audio");
    if (file.size !== audio.size_bytes) {
      return fail(409, "Audio size does not match its registration");
    }

    const mimeType = audio.format === "wav" ? "audio/wav" : "audio/mpeg";
    const form = new FormData();
    form.set("file", file.slice(0, file.size, mimeType), `audio.${audio.format}`);
    form.set("model", "whisper-large-v3");
    form.set("response_format", "verbose_json");
    form.append("timestamp_granularities[]", "segment");
    if (language !== undefined) form.set("language", language);

    const groqResponse = await requestGroqTranscription(
      form,
      apiKey,
      signal,
      deadline,
    );

    if (signal.aborted || Date.now() >= deadline) {
      return fail(504, "Transcription timed out");
    }
    if (!groqResponse?.ok) {
      return fail(
        groqResponse?.status === 429 ? 503 : 502,
        "Transcription provider could not process the audio",
      );
    }

    let transcript: ReturnType<typeof normalizeTranscription>;
    try {
      transcript = normalizeTranscription(await groqResponse.json());
    } catch {
      if (signal.aborted) return fail(504, "Transcription timed out");
      return fail(502, "Transcription provider returned an invalid result");
    }

    const { data: saved, error: saveError } = await supabase
      .rpc("save_transcript", {
        p_meeting_id: meetingId,
        p_expected_version_id: expectedVersionId,
        ...transcript,
      })
      .abortSignal(signal)
      .single();

    if (saveError?.code === "PT409") return fail(409, "Transcript version conflict");
    if (saveError?.code === "42501") return fail(403, "Project access denied");
    if (signal.aborted) return fail(504, "Transcription timed out");
    if (saveError || !saved) return fail(500, "Could not save transcript");

    return Response.json(saved, { status: 201, headers: noStore });
  } catch {
    if (signal.aborted) return fail(504, "Transcription timed out");
    return fail(500, "Could not complete transcription");
  }
}
