import type { SupabaseClient } from "@supabase/supabase-js";
import { exceedsLength, isUuid } from "@/lib/api/request";

const maxTextCharacters = 500_000;

// At most four UTF-8 bytes per character, plus an optional three-byte BOM.
const maxTextBytes = maxTextCharacters * 4 + 3;

type UploadedFileMetadata = {
  storage_path: string;
  format: string;
  size_bytes: number;
};

export class UploadedTxtError extends Error {
  readonly status: number;

  constructor(status: number, message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "UploadedTxtError";
    this.status = status;
  }
}

function isUploadedFileMetadata(
  value: unknown,
): value is UploadedFileMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    "storage_path" in value &&
    typeof value.storage_path === "string" &&
    "format" in value &&
    typeof value.format === "string" &&
    "size_bytes" in value &&
    typeof value.size_bytes === "number" &&
    Number.isSafeInteger(value.size_bytes) &&
    value.size_bytes > 0
  );
}

export async function readUploadedTxt(
  supabase: SupabaseClient,
  meetingId: string,
  fileId: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();

  if (!isUuid(meetingId) || !isUuid(fileId)) {
    throw new UploadedTxtError(400, "Invalid meeting or file ID");
  }

  const { data: metadata, error: metadataError } = await supabase
    .rpc("get_uploaded_meeting_file", {
      p_meeting_id: meetingId,
      p_file_id: fileId,
    })
    .abortSignal(signal)
    .maybeSingle();

  signal.throwIfAborted();

  if (metadataError) {
    throw new UploadedTxtError(
      500,
      "Could not load file metadata",
      metadataError,
    );
  }

  if (!metadata) {
    throw new UploadedTxtError(404, "Uploaded file not found");
  }

  const expectedPath =
    `${meetingId.toLowerCase()}/${fileId.toLowerCase()}`;

  if (
    !isUploadedFileMetadata(metadata) ||
    metadata.storage_path !== expectedPath
  ) {
    throw new UploadedTxtError(500, "Invalid stored file metadata");
  }

  if (metadata.format !== "txt") {
    throw new UploadedTxtError(400, "The uploaded file must be TXT");
  }

  if (metadata.size_bytes > maxTextBytes) {
    throw new UploadedTxtError(
      400,
      `TXT content must be at most ${maxTextCharacters} characters`,
    );
  }

  const { data: file, error: downloadError } = await supabase.storage
    .from("meeting-files")
    .download(metadata.storage_path, {}, { cache: "no-store", signal });

  signal.throwIfAborted();

  if (downloadError || !file) {
    throw new UploadedTxtError(
      502,
      "Could not download the uploaded TXT file",
      downloadError,
    );
  }

  if (file.size !== metadata.size_bytes) {
    throw new UploadedTxtError(
      409,
      "File size does not match its registration",
    );
  }

  const bytes = await file.arrayBuffer();
  signal.throwIfAborted();

  let text: string;

  try {
    text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch (error) {
    throw new UploadedTxtError(
      400,
      "TXT file must contain valid UTF-8 text",
      error,
    );
  }

  if (text.includes("\0")) {
    throw new UploadedTxtError(
      400,
      "TXT content must not contain null characters",
    );
  }

  if (text.trim() === "") {
    throw new UploadedTxtError(400, "TXT content must not be empty");
  }

  if (exceedsLength(text, maxTextCharacters)) {
    throw new UploadedTxtError(
      400,
      `TXT content must be at most ${maxTextCharacters} characters`,
    );
  }

  signal.throwIfAborted();

  return text;
}