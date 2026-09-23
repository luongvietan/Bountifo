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

/**
 * Downloads a text report via a blob object URL — sized for the radar report
 * export, whose all-profile/uncapped bodies outgrow what a data: URL should
 * carry. The object URL must outlive the browser's read of the blob, so it is
 * released only when the download item reaches a terminal state (with a
 * fallback timer so a never-fired event cannot pin it forever).
 */
export async function downloadFile(
  filename: string,
  body: string,
  mime: string,
): Promise<void> {
  const url = URL.createObjectURL(
    new Blob([body], { type: `${mime};charset=utf-8` }),
  );
  let id: number;
  try {
    id = await browser.downloads.download({
      url,
      filename,
      saveAs: false,
      conflictAction: "uniquify",
    });
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
  await new Promise<void>((resolve) => {
    const release = () => {
      browser.downloads.onChanged.removeListener(listener);
      window.clearTimeout(timer);
      resolve();
    };
    const listener = (delta: {
      id: number;
      state?: { current?: string };
    }) => {
      const state = delta.state?.current;
      if (delta.id === id && (state === "complete" || state === "interrupted")) {
        release();
      }
    };
    const timer = window.setTimeout(release, 60_000);
    browser.downloads.onChanged.addListener(listener);
  });
  URL.revokeObjectURL(url);
}
