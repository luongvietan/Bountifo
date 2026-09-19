import { defineConfig } from "wxt";

export default defineConfig({
  outDir: ".output",
  manifest: {
    permissions: ["activeTab", "scripting", "storage", "downloads"],
    host_permissions: ["https://bugcrowd.com/*", "https://api.bugcrowd.com/*"],
  },
});
