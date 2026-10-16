import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Re-registers Pi's own `openrouter` provider with only a new endpoint, as a proxy wrapper
// does. Pi keeps the provider's built-in models and authentication, including its OAuth
// refresh, which returns the stored credential unchanged without a network request.
export default function openRouterBaseUrl(pi: ExtensionAPI): void {
  pi.registerProvider("openrouter", {
    baseUrl: process.env.PI_AGENT_FIXTURE_BASE_URL ?? "http://127.0.0.1:1/v1",
  });
}
