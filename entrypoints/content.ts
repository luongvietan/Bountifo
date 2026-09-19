export default defineContentScript({
  matches: ["https://bugcrowd.com/*"],
  runAt: "document_idle",
  main() {},
});
