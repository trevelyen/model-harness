import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiPlugin } from "./server/api.ts";

const port = Number(process.env.PORT) || 5173;
const host = process.env.HOST || "127.0.0.1";

export default defineConfig({
  plugins: [react(), apiPlugin()],
  server: { port, host, strictPort: true },
  preview: { port, host, strictPort: true },
});
