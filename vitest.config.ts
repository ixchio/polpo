import { defineConfig } from "vitest/config";
import { loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  // Load .env, .env.test, etc. into process.env (empty prefix = all vars)
  const env = loadEnv(mode, process.cwd(), "");
  return {
    test: {
      env,
    },
  };
});
