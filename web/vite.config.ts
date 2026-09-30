/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API serves this app in production. In development, Vite proxies API calls to it.
const API = process.env.API_URL ?? "http://localhost:8080";

export default defineConfig({
  base: "/",
  plugins: [react()],
  server: {
    proxy: { "/api": API },
  },
  build: { sourcemap: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
