import { describe, expect, it } from "vitest";
import {
  describeUnusableDefaultModel,
  findUnusableDefaultModel,
  type HeadlessModelRef,
  type HeadlessModelSelection,
} from "../src/server/headless-step-model.js";

const FALLBACK: HeadlessModelRef = { provider: "fallback", id: "fallback-model" };
const DEFAULT: HeadlessModelRef = { provider: "custom", id: "custom-model" };
const OTHER: HeadlessModelRef = { provider: "custom", id: "other-model" };

type Catalog = { models: HeadlessModelRef[]; authenticated: string[] };

/** A child that started on `selected`, with `defaultProvider/defaultModel` set to DEFAULT. */
function selection(
  overrides: Partial<HeadlessModelSelection> = {},
  catalog: Catalog = { models: [FALLBACK], authenticated: ["fallback"] },
): HeadlessModelSelection {
  return {
    explicitModel: false,
    defaultProvider: DEFAULT.provider,
    defaultModel: DEFAULT.id,
    selected: FALLBACK,
    scoped: [],
    find: (provider, id) =>
      catalog.models.find((model) => model.provider === provider && model.id === id),
    hasProvider: (provider) => catalog.models.some((model) => model.provider === provider),
    hasConfiguredAuth: (model) => catalog.authenticated.includes(model.provider),
    ...overrides,
  };
}

const ALL_KNOWN: Catalog = {
  models: [FALLBACK, DEFAULT, OTHER],
  authenticated: ["fallback", "custom"],
};

describe("findUnusableDefaultModel", () => {
  it("reports a default whose provider headless pi does not have", () => {
    expect(findUnusableDefaultModel(selection())).toEqual({
      provider: "custom",
      model: "custom-model",
      reason:
        'provider "custom" is not available in headless pi, which loads only the pi-workflows bridge, any extension in PI_WORKFLOWS_HEADLESS_EXTENSIONS, and any extension in the server\'s extra Pi arguments',
      selected: FALLBACK,
    });
  });

  it("reports a default model that its provider does not have", () => {
    const found = findUnusableDefaultModel(
      selection({}, { models: [FALLBACK, OTHER], authenticated: ["fallback", "custom"] }),
    );
    expect(found?.reason).toBe('provider "custom" has no model "custom-model" in headless pi');
  });

  it("reports a default whose provider has no authentication", () => {
    const found = findUnusableDefaultModel(
      selection({}, { models: [FALLBACK, DEFAULT], authenticated: ["fallback"] }),
    );
    expect(found?.reason).toBe('provider "custom" has no configured authentication in headless pi');
  });

  it("reports a usable default that Pi did not start on", () => {
    expect(findUnusableDefaultModel(selection({}, ALL_KNOWN))?.reason).toBe("Pi did not select it");
    // A scope that holds the default makes Pi choose it, so another model is still wrong.
    expect(
      findUnusableDefaultModel(selection({ scoped: [FALLBACK, DEFAULT] }, ALL_KNOWN))?.reason,
    ).toBe("Pi did not select it");
  });

  it("reports an unusable default even when a model scope is set", () => {
    expect(findUnusableDefaultModel(selection({ scoped: [FALLBACK] }))?.provider).toBe("custom");
  });

  it("reports an unusable default when Pi found no model at all", () => {
    expect(findUnusableDefaultModel(selection({ selected: undefined }))?.selected).toBeUndefined();
  });

  it("accepts the session model when it is the default", () => {
    expect(findUnusableDefaultModel(selection({ selected: DEFAULT }, ALL_KNOWN))).toBeUndefined();
    // Pi resolves the configured name in its catalog; the session reports the catalog model.
    const alias = selection(
      { defaultModel: "custom-alias", selected: DEFAULT },
      { models: [FALLBACK, DEFAULT], authenticated: ["custom"] },
    );
    alias.find = (provider) => (provider === "custom" ? DEFAULT : undefined);
    expect(findUnusableDefaultModel(alias)).toBeUndefined();
  });

  it("accepts any model that the command line chose", () => {
    expect(findUnusableDefaultModel(selection({ explicitModel: true }))).toBeUndefined();
  });

  it("keeps Pi's first available model when no complete default is set", () => {
    expect(
      findUnusableDefaultModel(selection({ defaultProvider: undefined, defaultModel: undefined })),
    ).toBeUndefined();
    expect(findUnusableDefaultModel(selection({ defaultModel: undefined }))).toBeUndefined();
    expect(findUnusableDefaultModel(selection({ defaultProvider: "" }))).toBeUndefined();
  });

  it("accepts the first scoped model when a usable default is outside the scope", () => {
    expect(
      findUnusableDefaultModel(selection({ selected: OTHER, scoped: [OTHER] }, ALL_KNOWN)),
    ).toBeUndefined();
  });
});

describe("describeUnusableDefaultModel", () => {
  const unusable = {
    provider: "custom",
    model: "custom-model",
    reason: 'provider "custom" is not available in headless pi',
    selected: FALLBACK,
  };

  it("names the default, its settings file, the reason, the fallback, and the fixes", () => {
    expect(
      describeUnusableDefaultModel(unusable, {
        defaultProvider: "/home/u/.pi/agent/settings.json",
        defaultModel: "/home/u/.pi/agent/settings.json",
      }),
    ).toBe(
      'Headless pi cannot run workflow steps on the default model "custom/custom-model" from Pi settings (set in /home/u/.pi/agent/settings.json): provider "custom" is not available in headless pi. Pi would have used "fallback/fallback-model" instead, so headless pi stopped before any model request. Load the provider\'s extension with `PI_WORKFLOWS_HEADLESS_EXTENSIONS=/absolute/path/to/extension` or `pi-workflows server run -- -e /absolute/path/to/extension`, choose a model with `pi-workflows server run -- --provider <provider> --model <model>`, or change the default. The workflow server reads `PI_WORKFLOWS_HEADLESS_EXTENSIONS` and its extra Pi arguments only when it starts, so restart it with `pi-workflows server stop` after a change; `pi-workflows server status` shows the loaded `headlessExtensions`.',
    );
  });

  it("names each settings file when the fields come from different files", () => {
    expect(
      describeUnusableDefaultModel(unusable, {
        defaultProvider: "/home/u/.pi/agent/settings.json",
        defaultModel: "/repo/.pi/settings.json",
      }),
    ).toContain(
      "from Pi settings (defaultProvider in /home/u/.pi/agent/settings.json, defaultModel in /repo/.pi/settings.json):",
    );
    expect(
      describeUnusableDefaultModel(unusable, {
        defaultProvider: undefined,
        defaultModel: "/repo/.pi/settings.json",
      }),
    ).toContain("from Pi settings (defaultModel in /repo/.pi/settings.json):");
  });

  it("omits unknown settings files and reports when Pi had no other model", () => {
    const message = describeUnusableDefaultModel(
      { ...unusable, selected: undefined },
      { defaultProvider: undefined, defaultModel: undefined },
    );
    expect(message).toContain('"custom/custom-model" from Pi settings: provider');
    expect(message).toContain(
      "Pi found no other model, so headless pi stopped before any model request.",
    );
    expect(message).toMatch(
      / or change the default\. The workflow server reads `PI_WORKFLOWS_HEADLESS_EXTENSIONS` and its extra Pi arguments only when it starts, so restart it with `pi-workflows server stop` after a change; `pi-workflows server status` shows the loaded `headlessExtensions`\.$/,
    );
  });
});
