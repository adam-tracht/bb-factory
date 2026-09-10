import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        inline: ["@get-bb/plugin-sdk"],
      },
    },
    include: ["tests/**/*.test.ts"],
  },
});
