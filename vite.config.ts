import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Web Bluetooth requires a secure context. localhost counts as secure, so the
// dev server works as-is. To test from another device on your LAN, run
// `vite --host` and use an HTTPS tunnel (Web Bluetooth won't work over plain
// http:// to a LAN IP).
export default defineConfig({
  plugins: [react()],
  // Relative base so the built app works from any path, including a GitHub Pages
  // project subpath like https://<user>.github.io/<repo>/. The app has no
  // client-side routing, so relative asset URLs are all that's needed.
  base: "./",
  server: {
    host: true,
  },
});
