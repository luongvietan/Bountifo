function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function downloadMarkdown(
  filename: string,
  markdown: string,
): Promise<void> {
  const encoded = bytesToBase64(new TextEncoder().encode(markdown));
  await browser.downloads.download({
    url: `data:text/markdown;charset=utf-8;base64,${encoded}`,
    filename,
    saveAs: false,
    conflictAction: "uniquify",
  });
}
