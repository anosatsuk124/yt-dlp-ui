// Quality presets mirror the values the downloader knows how to translate
// into a yt-dlp -f selector. Keep these in sync with downloader/cmd/downloader/main.go.

export type FormatKey = "best" | "1080p" | "720p" | "audio";

export const FORMATS: Record<FormatKey, { label: string }> = {
  best:    { label: "Best" },
  "1080p": { label: "1080p" },
  "720p":  { label: "720p" },
  audio:   { label: "Audio (mp3)" },
};

export function isFormatKey(value: unknown): value is FormatKey {
  return typeof value === "string" && value in FORMATS;
}
