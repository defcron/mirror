import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "/mirror/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
});
