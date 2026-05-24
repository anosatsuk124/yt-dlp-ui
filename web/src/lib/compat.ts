// Codec compatibility profiles. The downloader translates these into
// strict -f selector chains so the resulting file is playable on the
// targeted platform.
//   - auto: best codec yt-dlp can grab; no compatibility constraint
//   - ios:  H.264 (avc1) + AAC (mp4a) packed in .mp4. Required for the
//          MEGA iOS / iPadOS app, which silently fails on VP9/Opus/HEVC.

export type CompatKey = "auto" | "ios";

export const COMPATS: Record<CompatKey, { label: string; hint: string }> = {
  auto: { label: "Auto",     hint: "Best codec yt-dlp can grab." },
  ios:  { label: "iOS / Apple", hint: "H.264 + AAC in MP4. Works in MEGA mobile and Apple Photos." },
};

export function isCompatKey(v: unknown): v is CompatKey {
  return typeof v === "string" && v in COMPATS;
}
