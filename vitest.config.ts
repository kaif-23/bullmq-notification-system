import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/integration/**/*.test.ts"],
        setupFiles: ["tests/setup/lifecycle.ts"],
        fileParallelism: false,
        maxWorkers: 1,
        minWorkers: 1,
        restoreMocks: true
    }
});
