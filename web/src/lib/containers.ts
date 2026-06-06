// Output container presets, split by format kind.
//
// Video containers: "auto" leaves the container to yt-dlp's default; the
// others map straight to `--merge-output-format <ext>` on the downloader
// side — fast remux, no re-encode unless codec-incompatible.
//
// Audio codecs: the audio is extracted and transcoded into this codec via
// `-x --audio-format <codec>`. There is no "auto" — an audio-only download
// must pick a concrete codec.

import type { FormatKind } from "./formats";

export type VideoContainer = "auto" | "mp4" | "mkv" | "webm" | "mov";
export type AudioCodec = "mp3" | "wav" | "flac";
export type ContainerKey = VideoContainer | AudioCodec;

export const VIDEO_CONTAINERS: VideoContainer[] = ["auto", "mp4", "mkv", "webm", "mov"];
export const AUDIO_CODECS: AudioCodec[] = ["mp3", "wav", "flac"];

export const CONTAINER_LABELS: Record<ContainerKey, string> = {
  auto: "Auto",
  mp4:  "MP4",
  mkv:  "MKV",
  webm: "WebM",
  mov:  "MOV",
  mp3:  "MP3",
  wav:  "WAV",
  flac: "FLAC",
};

export function containersFor(kind: FormatKind): ContainerKey[] {
  return kind === "audio" ? AUDIO_CODECS : VIDEO_CONTAINERS;
}

export function isContainerKey(v: unknown): v is ContainerKey {
  return typeof v === "string" && v in CONTAINER_LABELS;
}

export function isVideoContainer(v: unknown): v is VideoContainer {
  return typeof v === "string" && (VIDEO_CONTAINERS as string[]).includes(v);
}

export function isAudioCodec(v: unknown): v is AudioCodec {
  return typeof v === "string" && (AUDIO_CODECS as string[]).includes(v);
}

// Validate that a container belongs to the given format kind.
export function isContainerValidFor(kind: FormatKind, v: unknown): boolean {
  return kind === "audio" ? isAudioCodec(v) : isVideoContainer(v);
}

// Backwards label compatibility for the few call sites that still import the
// old CONTAINERS map shape ({ [key]: { label } }).
export const CONTAINERS: Record<ContainerKey, { label: string }> = Object.fromEntries(
  (Object.keys(CONTAINER_LABELS) as ContainerKey[]).map(k => [k, { label: CONTAINER_LABELS[k] }]),
) as Record<ContainerKey, { label: string }>;
