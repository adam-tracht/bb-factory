import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// server-rpc.test.ts exercises the SDK fake host's RPC boundary. SDK 0.4.47
// imports its optional scheduler peer while loading that harness, even though
// this plugin registers no scheduler. The shim is deliberately throwing so a
// future scheduler test cannot pass without the real peer dependency.
export default defineConfig({
  resolve: {
    alias: {
      "cron-parser": fileURLToPath(new URL("./tests/cron-parser-shim.ts", import.meta.url)),
    },
  },
  test: {
    server: {
      deps: {
        inline: ["@get-bb/plugin-sdk"],
      },
    },
    include: ["tests/**/*.test.ts"],
  },
});
