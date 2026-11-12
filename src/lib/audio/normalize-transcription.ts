type TranscriptSegment = {
  text: string
  start_ms: number
  end_ms: number
}

type TranscriptContent = {
  p_full_text: string
  p_segments: TranscriptSegment[]
}

function toMilliseconds(seconds: number): number {
  const milliseconds = Math.round(seconds * 1_000)
  if (seconds < 0 || !Number.isSafeInteger(milliseconds)) {
    throw new Error('Invalid transcription timestamp')
  }
  return milliseconds
}

export function normalizeTranscription(response: unknown): TranscriptContent {
  if (typeof response !== 'object' || response === null) {
    throw new Error('Invalid transcription response')
  }

  const { text, segments } = response as { text?: unknown; segments?: unknown }

  if (typeof text !== 'string' || text.trim() === '') {
    throw new Error('Transcription text is empty')
  }

  if (segments == null || (Array.isArray(segments) && segments.length === 0)) {
    return { p_full_text: text, p_segments: [] }
  }

  if (!Array.isArray(segments)) {
    throw new Error('Invalid transcription segments')
  }

  const normalized = segments.map((value: unknown): TranscriptSegment => {
    if (typeof value !== 'object' || value === null) {
      throw new Error('Invalid transcription segment')
    }

    const segment = value as { text?: unknown; start?: unknown; end?: unknown }
    if (
      typeof segment.text !== 'string' || segment.text === '' ||
      typeof segment.start !== 'number' || typeof segment.end !== 'number' ||
      segment.end < segment.start
    ) {
      throw new Error('Invalid transcription segment')
    }

    return {
      text: segment.text,
      start_ms: toMilliseconds(segment.start),
      end_ms: toMilliseconds(segment.end),
    }
  })

  const reconstructed = normalized.map(segment => segment.text).join('')
  if (reconstructed.trim() !== text.trim()) {
    return { p_full_text: text, p_segments: [] }
  }

  return { p_full_text: reconstructed, p_segments: normalized }
}