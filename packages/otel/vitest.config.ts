import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "otel",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
