import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/**/*.test.ts"], isolate: true, pool: "forks", testTimeout: 20000 } });
