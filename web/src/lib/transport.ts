// Transport selection for talking to the Go downloader.
//
// In Docker mode the downloader listens on TCP (DOWNLOADER_URL) and a plain
// fetch works. In the Tauri desktop build it listens on a Unix domain socket /
// Windows named pipe (DOWNLOADER_SOCKET) and no TCP port is opened — every
// request is then routed through an undici Agent bound to that socket.
//
// undici's fetch and Agent are imported from the *same* module on purpose: the
// global fetch will reject a dispatcher created by a separately-resolved undici
// instance ("not an instance of Dispatcher"), whereas this pairing always matches.
import { Agent, fetch as undiciFetch, type RequestInfo, type RequestInit } from "undici";
import { DOWNLOADER_SOCKET } from "./env";

export const downloaderDispatcher = DOWNLOADER_SOCKET
  ? new Agent({ connect: { socketPath: DOWNLOADER_SOCKET } })
  : undefined;

// fetch bound to the downloader transport. With DOWNLOADER_SOCKET unset the
// dispatcher is undefined and this behaves like a normal fetch (TCP). The URL's
// host is irrelevant when a socket dispatcher is set (connection goes to the
// socket), so the existing DOWNLOADER_URL value is reused as a dummy authority.
export function downloaderFetch(input: RequestInfo, init?: RequestInit) {
  return undiciFetch(input, { ...init, dispatcher: downloaderDispatcher });
}
