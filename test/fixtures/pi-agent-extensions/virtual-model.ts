import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// A virtual model under Pi's built-in Cerebras provider. Its router would send every request
// to a physical Cerebras model, so a session that accepted it would not run the exact dispatch.
export default function virtualModel(pi: ExtensionAPI): void {
  pi.registerVirtualModel({
    provider: "cerebras",
    id: "fixture-virtual",
    name: "Fixture virtual model",
    thinkingLevels: ["high"],
    route(_request, ctx) {
      const model = ctx.modelRegistry.find("cerebras", "gpt-oss-120b");
      if (model === undefined) throw new Error("fixture route target is missing");
      return { model, thinkingLevel: "high" };
    },
  });
}
