// Quality presets mirror the values the downloader knows how to translate
// into a yt-dlp -f selector. Keep these in sync with downloader/cmd/downloader/main.go.
//
// Each preset carries a `kind`:
//   - video: a full video+audio download; its containers are remux targets
//            (auto/mp4/mkv/webm/mov) via --merge-output-format.
//   - audio: an audio-only extraction; its "containers" are the codec the
//            audio is transcoded into (mp3/wav/flac) via --audio-format.

export type FormatKind = "video" | "audio";

export type FormatKey = "best" | "1080p" | "720p" | "audio-best";

export const FORMATS: Record<FormatKey, { label: string; kind: FormatKind }> = {
  best:         { label: "Best",         kind: "video" },
  "1080p":      { label: "1080p",        kind: "video" },
  "720p":       { label: "720p",         kind: "video" },
  "audio-best": { label: "Audio (Best)", kind: "audio" },
};

export function isFormatKey(value: unknown): value is FormatKey {
  return typeof value === "string" && value in FORMATS;
}

// Older DB rows / saved settings used the bare "audio" key (always mp3).
// Map it onto the new audio-best preset so history and defaults keep working.
export function normalizeFormatKey(value: string): FormatKey {
  if (value === "audio") return "audio-best";
  return isFormatKey(value) ? value : "best";
}

export function formatKind(key: string): FormatKind {
  const norm = normalizeFormatKey(key);
  return FORMATS[norm].kind;
}
