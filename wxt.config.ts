import { defineConfig } from "wxt";

export default defineConfig({
  outDir: ".output",
  manifest: {
    permissions: [
      "activeTab",
      "scripting",
      "storage",
      "downloads",
    ],
    host_permissions: ["https://bugcrowd.com/*", "https://api.bugcrowd.com/*"],
  },
  vite: () => ({
    define: {
      // Baked into the bundle so reports can record the source commit.
      // Build with e.g. BOUNTIFO_COMMIT_SHA=$(git rev-parse HEAD); absent → "".
      "import.meta.env.VITE_COMMIT_SHA": JSON.stringify(
        process.env.BOUNTIFO_COMMIT_SHA ?? "",
      ),
    },
  }),
});
