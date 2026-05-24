// Output container presets. "auto" leaves the container to yt-dlp's
// default (whatever the natural muxer picks for the chosen streams).
// The others map straight to `--merge-output-format <ext>` on the
// downloader side — fast remux, no re-encode unless codec-incompatible.

export type ContainerKey = "auto" | "mp4" | "mkv" | "webm" | "mov";

export const CONTAINERS: Record<ContainerKey, { label: string }> = {
  auto: { label: "Auto" },
  mp4:  { label: "MP4" },
  mkv:  { label: "MKV" },
  webm: { label: "WebM" },
  mov:  { label: "MOV" },
};

export function isContainerKey(v: unknown): v is ContainerKey {
  return typeof v === "string" && v in CONTAINERS;
}
