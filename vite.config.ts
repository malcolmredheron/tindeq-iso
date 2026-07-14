import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Web Bluetooth requires a secure context. localhost counts as secure, so the
// dev server works as-is. To test from another device on your LAN, run
// `vite --host` and use an HTTPS tunnel (Web Bluetooth won't work over plain
// http:// to a LAN IP).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
  },
});
