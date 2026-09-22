import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["tests/integration/**/*.test.ts"],
        setupFiles: ["tests/setup/lifecycle.ts"],
        fileParallelism: false,
        restoreMocks: true
    }
});
