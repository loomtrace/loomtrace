import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  target: "es2022",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  external: ["@loomtrace/core"],
  // The shebang lives in src/cli.ts — esbuild preserves it, and tsup sets
  // the executable bit on the resulting file.
});
