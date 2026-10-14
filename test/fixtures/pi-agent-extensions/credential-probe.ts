import fs from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Records, for each listed provider, whether the child session's model runtime can resolve an
// API key. It writes only `present` or `absent`, never a key.
export default function credentialProbe(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const file = process.env.PI_AGENT_CREDENTIAL_PROBE_FILE;
    if (!file) return;
    const providers = (process.env.PI_AGENT_CREDENTIAL_PROBE_PROVIDERS ?? "").split(",");
    const lines: string[] = [];
    for (const provider of providers) {
      const key = await ctx.modelRegistry.getApiKeyForProvider(provider);
      lines.push(`${provider}=${key === undefined ? "absent" : "present"}`);
    }
    await fs.appendFile(file, `${lines.join("\n")}\n`, "utf8");
  });
}
