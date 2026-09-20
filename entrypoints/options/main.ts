import { browser } from "wxt/browser";

const input = document.querySelector<HTMLInputElement>("#token")!;
const status = document.querySelector<HTMLElement>("#token-status")!;
const result = document.querySelector<HTMLElement>("#result")!;

async function refreshStatus(): Promise<void> {
  const response = (await browser.runtime.sendMessage({ op: "GET_TOKEN_STATUS" })) as {
    ok?: boolean;
    configured?: boolean;
  };
  status.textContent = response.configured ? "Token configured" : "Token not configured";
}

document.querySelector<HTMLButtonElement>("#save")!.addEventListener("click", async () => {
  const response = (await browser.runtime.sendMessage({ op: "SAVE_TOKEN", token: input.value })) as {
    ok?: boolean;
    error?: string;
  };
  result.textContent = response.ok ? "Token saved." : `Token not saved: ${response.error ?? "invalid token"}`;
  input.value = "";
  await refreshStatus();
});

document.querySelector<HTMLButtonElement>("#test")!.addEventListener("click", async () => {
  const candidate = input.value.trim();
  const response = (await browser.runtime.sendMessage({
    op: "TEST_TOKEN",
    params: candidate === "" ? {} : { token: candidate },
  })) as { ok?: boolean; data?: { detail?: string }; error?: { message?: string } | string };
  result.textContent = response.ok
    ? response.data?.detail ?? "Token valid"
    : typeof response.error === "string"
      ? response.error
      : response.error?.message ?? "Token test failed";
  input.value = "";
});

document.querySelector<HTMLButtonElement>("#clear")!.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ op: "CLEAR_TOKEN" });
  input.value = "";
  result.textContent = "Token cleared.";
  await refreshStatus();
});

void refreshStatus();
