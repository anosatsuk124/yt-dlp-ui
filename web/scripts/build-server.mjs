// Bundle the custom Next.js server (server.ts + src/lib/*) into a single CommonJS
// file for the desktop package, so the runtime needs only `node` — no tsx.
//
// All npm dependencies stay external (loaded at runtime from the shipped,
// production-pruned node_modules); only our own TypeScript is inlined. Next.js
// itself reads .next/ and next.config.mjs from the process cwd at runtime.
//
// Usage: node scripts/build-server.mjs [outfile]
import { build } from "esbuild";

const outfile = process.argv[2] ?? "dist-server/server.js";

await build({
  entryPoints: ["server.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outfile,
  packages: "external",
  // Mirror the tsconfig "@/*" -> "./src/*" path alias for any lib that uses it.
  alias: { "@": "./src" },
  logLevel: "info",
});

console.log(`built ${outfile}`);
