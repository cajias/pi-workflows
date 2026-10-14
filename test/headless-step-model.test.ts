import { describe, expect, it } from "vitest";
import {
  describeHeadlessModelProblem,
  findHeadlessModelProblem,
  type HeadlessModelRef,
  type HeadlessModelScope,
  type HeadlessModelSelection,
  type ModelSettingSources,
} from "../src/server/headless-step-model.js";

const FALLBACK: HeadlessModelRef = { provider: "fallback", id: "fallback-model" };
const DEFAULT: HeadlessModelRef = { provider: "custom", id: "custom-model" };
const OTHER: HeadlessModelRef = { provider: "custom", id: "other-model" };
const NO_SCOPE: HeadlessModelScope = { patterns: [], fromCommandLine: false, models: [] };
const NO_SOURCES: ModelSettingSources = {
  defaultProvider: undefined,
  defaultModel: undefined,
  enabledModels: undefined,
};
const RESTART =
  "The workflow server reads `PI_WORKFLOWS_HEADLESS_EXTENSIONS` and its extra Pi arguments only when it starts, so restart it with `pi-workflows server stop` after a change; `pi-workflows server status` shows the loaded `headlessExtensions`.";

type Catalog = { models: HeadlessModelRef[]; authenticated: string[] };

/** A child that started on `selected`, with `defaultProvider/defaultModel` set to DEFAULT. */
function selection(
  overrides: Partial<HeadlessModelSelection> = {},
  catalog: Catalog = { models: [FALLBACK], authenticated: ["fallback"] },
): HeadlessModelSelection {
  return {
    explicitModel: false,
    scope: NO_SCOPE,
    defaultProvider: DEFAULT.provider,
    defaultModel: DEFAULT.id,
    selected: FALLBACK,
    find: (provider, id) =>
      catalog.models.find((model) => model.provider === provider && model.id === id),
    hasProvider: (provider) => catalog.models.some((model) => model.provider === provider),
    hasConfiguredAuth: (model) => catalog.authenticated.includes(model.provider),
    ...overrides,
  };
}

/** A model scope from `enabledModels`, which Pi resolved to `models`. */
function scope(models: HeadlessModelRef[], patterns = ["custom/*", "fallback/*"]) {
  return { patterns, fromCommandLine: false, models };
}

const ALL_KNOWN: Catalog = {
  models: [FALLBACK, DEFAULT, OTHER],
  authenticated: ["fallback", "custom"],
};

describe("findHeadlessModelProblem without a model scope", () => {
  it("reports a default whose provider headless pi does not have", () => {
    expect(findHeadlessModelProblem(selection())).toEqual({
      kind: "default",
      provider: "custom",
      model: "custom-model",
      reason:
        'provider "custom" is not available in headless pi, which loads only the pi-workflows bridge, any extension in PI_WORKFLOWS_HEADLESS_EXTENSIONS, and any extension in the server\'s extra Pi arguments',
      selected: FALLBACK,
    });
  });

  it("reports a default model that its provider does not have", () => {
    const found = findHeadlessModelProblem(
      selection({}, { models: [FALLBACK, OTHER], authenticated: ["fallback", "custom"] }),
    );
    expect(found?.reason).toBe('provider "custom" has no model "custom-model" in headless pi');
  });

  it("reports a default whose provider has no authentication", () => {
    const found = findHeadlessModelProblem(
      selection({}, { models: [FALLBACK, DEFAULT], authenticated: ["fallback"] }),
    );
    expect(found?.reason).toBe('provider "custom" has no configured authentication in headless pi');
  });

  it("reports a usable default that Pi did not start on", () => {
    expect(findHeadlessModelProblem(selection({}, ALL_KNOWN))?.reason).toBe("Pi did not select it");
  });

  it("reports an unusable default when Pi found no model at all", () => {
    expect(findHeadlessModelProblem(selection({ selected: undefined }))).toMatchObject({
      kind: "default",
      selected: undefined,
    });
  });

  it("accepts the session model when it is the default", () => {
    expect(findHeadlessModelProblem(selection({ selected: DEFAULT }, ALL_KNOWN))).toBeUndefined();
    // Pi resolves the configured name in its catalog; the session reports the catalog model.
    const alias = selection(
      { defaultModel: "custom-alias", selected: DEFAULT },
      { models: [FALLBACK, DEFAULT], authenticated: ["custom"] },
    );
    alias.find = (provider) => (provider === "custom" ? DEFAULT : undefined);
    expect(findHeadlessModelProblem(alias)).toBeUndefined();
  });

  it("accepts any model that the command line chose", () => {
    expect(findHeadlessModelProblem(selection({ explicitModel: true }))).toBeUndefined();
    expect(
      findHeadlessModelProblem(selection({ explicitModel: true, scope: scope([]) })),
    ).toBeUndefined();
  });

  it("keeps Pi's first available model when no complete default is set", () => {
    expect(
      findHeadlessModelProblem(selection({ defaultProvider: undefined, defaultModel: undefined })),
    ).toBeUndefined();
    expect(findHeadlessModelProblem(selection({ defaultModel: undefined }))).toBeUndefined();
    expect(findHeadlessModelProblem(selection({ defaultProvider: "" }))).toBeUndefined();
  });
});

describe("findHeadlessModelProblem with a model scope", () => {
  it("accepts the first usable scoped model when the default is unusable", () => {
    // Formerly a failure: the scope is the user's choice, so Pi may start inside it.
    expect(findHeadlessModelProblem(selection({ scope: scope([FALLBACK]) }))).toBeUndefined();
    expect(
      findHeadlessModelProblem(
        selection({
          scope: { patterns: ["fallback/*"], fromCommandLine: true, models: [FALLBACK] },
        }),
      ),
    ).toBeUndefined();
  });

  it("accepts any usable scoped model, whatever the default", () => {
    expect(
      findHeadlessModelProblem(selection({ selected: OTHER, scope: scope([OTHER]) }, ALL_KNOWN)),
    ).toBeUndefined();
    expect(
      findHeadlessModelProblem(
        selection({ scope: scope([FALLBACK, DEFAULT]), defaultModel: undefined }, ALL_KNOWN),
      ),
    ).toBeUndefined();
  });

  it("reports a scope in which Pi resolved no usable model", () => {
    // Pi then falls back to the default or its first available model, outside the scope.
    const patterns = ["custom/*"];
    expect(findHeadlessModelProblem(selection({ scope: scope([], patterns) }))).toEqual({
      kind: "scope",
      patterns,
      fromCommandLine: false,
      reason: "no model that headless pi can use matches it",
      selected: FALLBACK,
    });
    // A usable default outside the scope is no exception.
    expect(
      findHeadlessModelProblem(
        selection({ selected: DEFAULT, scope: scope([], ["other/*"]) }, ALL_KNOWN),
      )?.kind,
    ).toBe("scope");
    // Nor is a missing default, or no model at all.
    expect(
      findHeadlessModelProblem(
        selection({ scope: scope([]), defaultProvider: undefined, defaultModel: undefined }),
      )?.kind,
    ).toBe("scope");
    expect(
      findHeadlessModelProblem(selection({ scope: scope([]), selected: undefined }))?.selected,
    ).toBeUndefined();
  });

  it("reports a session model outside the resolved scope", () => {
    expect(
      findHeadlessModelProblem(selection({ selected: FALLBACK, scope: scope([OTHER]) }, ALL_KNOWN))
        ?.reason,
    ).toBe("Pi did not start on a model inside it");
    expect(
      findHeadlessModelProblem(selection({ selected: undefined, scope: scope([OTHER]) }, ALL_KNOWN))
        ?.reason,
    ).toBe("Pi did not start on a model inside it");
  });

  it("reports a scoped session model without authentication", () => {
    expect(
      findHeadlessModelProblem(
        selection(
          { selected: OTHER, scope: scope([OTHER]) },
          { models: [FALLBACK, OTHER], authenticated: ["fallback"] },
        ),
      )?.reason,
    ).toBe(
      'provider "custom" of the scoped model "other-model" has no configured authentication in headless pi',
    );
  });

  it("checks a scope that Pi resolved even without visible patterns", () => {
    expect(
      findHeadlessModelProblem(selection({ scope: { ...scope([OTHER]), patterns: [] } }, ALL_KNOWN))
        ?.kind,
    ).toBe("scope");
  });
});

describe("describeHeadlessModelProblem for a default", () => {
  const unusable = {
    kind: "default" as const,
    provider: "custom",
    model: "custom-model",
    reason: 'provider "custom" is not available in headless pi',
    selected: FALLBACK,
  };

  it("names the default, its settings file, the reason, the fallback, and the fixes", () => {
    expect(
      describeHeadlessModelProblem(unusable, {
        ...NO_SOURCES,
        defaultProvider: "/home/u/.pi/agent/settings.json",
        defaultModel: "/home/u/.pi/agent/settings.json",
      }),
    ).toBe(
      `Headless pi cannot run workflow steps on the default model "custom/custom-model" from Pi settings (set in /home/u/.pi/agent/settings.json): provider "custom" is not available in headless pi. Pi would have used "fallback/fallback-model" instead, so headless pi stopped before any model request. Load the provider's extension with \`PI_WORKFLOWS_HEADLESS_EXTENSIONS=/absolute/path/to/extension\` or \`pi-workflows server run -- -e /absolute/path/to/extension\`, choose a model with \`pi-workflows server run -- --provider <provider> --model <model>\`, or change the default. ${RESTART}`,
    );
  });

  it("names each settings file when the fields come from different files", () => {
    expect(
      describeHeadlessModelProblem(unusable, {
        ...NO_SOURCES,
        defaultProvider: "/home/u/.pi/agent/settings.json",
        defaultModel: "/repo/.pi/settings.json",
      }),
    ).toContain(
      "from Pi settings (defaultProvider in /home/u/.pi/agent/settings.json, defaultModel in /repo/.pi/settings.json):",
    );
    expect(
      describeHeadlessModelProblem(unusable, {
        ...NO_SOURCES,
        defaultModel: "/repo/.pi/settings.json",
      }),
    ).toContain("from Pi settings (defaultModel in /repo/.pi/settings.json):");
  });

  it("omits unknown settings files and reports when Pi had no other model", () => {
    const message = describeHeadlessModelProblem({ ...unusable, selected: undefined }, NO_SOURCES);
    expect(message).toContain('"custom/custom-model" from Pi settings: provider');
    expect(message).toContain(
      "Pi found no other model, so headless pi stopped before any model request.",
    );
    expect(message.endsWith(` or change the default. ${RESTART}`)).toBe(true);
  });
});

describe("describeHeadlessModelProblem for a model scope", () => {
  const unusable = {
    kind: "scope" as const,
    patterns: ["custom/*", "other"],
    fromCommandLine: false,
    reason: "no model that headless pi can use matches it",
    selected: FALLBACK,
  };

  it("names the scope, its settings file, the reason, the fallback, and the fixes", () => {
    expect(
      describeHeadlessModelProblem(unusable, {
        ...NO_SOURCES,
        enabledModels: "/repo/.pi/settings.json",
      }),
    ).toBe(
      `Headless pi cannot run workflow steps inside the model scope "custom/*", "other" from the \`enabledModels\` Pi setting in /repo/.pi/settings.json: no model that headless pi can use matches it. Pi would have used "fallback/fallback-model" instead, so headless pi stopped before any model request. Load the extension of a scoped model's provider with \`PI_WORKFLOWS_HEADLESS_EXTENSIONS=/absolute/path/to/extension\` or \`pi-workflows server run -- -e /absolute/path/to/extension\`, choose a model with \`pi-workflows server run -- --provider <provider> --model <model>\`, or change the scope. ${RESTART}`,
    );
  });

  it("names `--models` or an unknown settings file", () => {
    expect(
      describeHeadlessModelProblem({ ...unusable, fromCommandLine: true }, NO_SOURCES),
    ).toContain(
      'inside the model scope "custom/*", "other" from `--models` in the server\'s extra Pi arguments: no model',
    );
    expect(describeHeadlessModelProblem(unusable, NO_SOURCES)).toContain(
      "from the `enabledModels` Pi setting: no model",
    );
  });
});
