import { writeOsmManifest } from "./osmManifest.mjs";

const manifest = await writeOsmManifest();
console.log(
  `manifest.json: ${Object.keys(manifest.files).length} snapshots, version ${manifest.version.slice(0, 12)}.`,
);
