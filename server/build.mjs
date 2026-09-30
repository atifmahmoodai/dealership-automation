// Bundles the server (and the shared code it imports) into dist/, leaving npm packages external.
import { build } from "esbuild";
import { cpSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
await build({
  entryPoints: ["src/server.ts", "src/cli/migrate.ts", "src/cli/seed-demo.ts", "src/cli/create-admin.ts", "src/cli/worker.ts"],
  outdir: "dist",
  outbase: "src",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  sourcemap: true,
  logLevel: "info",
});
cpSync("migrations", "dist/migrations", { recursive: true });
