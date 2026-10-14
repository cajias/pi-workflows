/**
 * The model check that the rpc-bridge runs when a headless agent step's Pi child starts.
 *
 * Headless pi starts with `--no-extensions`, so the default model in Pi settings can name a
 * provider that only an unloaded user extension registers. Pi's `findInitialModel` then falls
 * back to the first available model without any diagnostic, and the step would run on a model
 * that nobody chose. Pi exits on an explicit `--model` that it cannot resolve, so only the
 * settings default and the model scope need this check. This module has no host imports, so
 * unit tests and the bridge share it.
 *
 * Pi 1.1.0 resolves the model scope from `--models`, or else from the `enabledModels` setting
 * (`main.js` 658-661), against its available models only (`core/model-resolver.js` 271-272).
 * The session keeps that resolved scope (`main.js` 417-420 and 681), and extensions read it as
 * `ctx.scopedModels`. With a non-empty resolved scope, Pi starts on the settings default when
 * the scope holds it and on the first scoped model otherwise (`main.js` 389-404). When no
 * pattern matches an available model, the resolved scope is empty and Pi falls back to the
 * settings default or its first available model (`core/sdk.js` 103-113,
 * `core/model-resolver.js` 502-530).
 */

export type HeadlessModelRef = { provider: string; id: string };

/** The model scope that the user set, and what Pi resolved from it. */
export type HeadlessModelScope<Model extends HeadlessModelRef = HeadlessModelRef> = {
  /** The patterns that Pi resolves: `--models`, else the `enabledModels` setting. */
  patterns: readonly string[];
  /** Whether the patterns come from `--models` rather than `enabledModels`. */
  fromCommandLine: boolean;
  /** The session's scoped models. Pi admits only available models. */
  models: readonly Model[];
};

/** What the bridge sees of the child's model selection at session start. */
export type HeadlessModelSelection<Model extends HeadlessModelRef = HeadlessModelRef> = {
  /** Pi's command line names a model with `--model`. Pi resolves it or exits. */
  explicitModel: boolean;
  scope: HeadlessModelScope<Model>;
  /** `defaultProvider` from the session's effective Pi settings. */
  defaultProvider: string | undefined;
  /** `defaultModel` from the session's effective Pi settings. */
  defaultModel: string | undefined;
  /** The model that the session starts on. */
  selected: HeadlessModelRef | undefined;
  /** Look a model up in the child's model catalog. */
  find(provider: string, id: string): Model | undefined;
  /** Whether the child's catalog has any model of `provider`. */
  hasProvider(provider: string): boolean;
  /** Whether the child has authentication configured for the provider of `model`. */
  hasConfiguredAuth(model: Model): boolean;
};

/** A settings default that the child could not use, and the model Pi chose instead. */
export type UnusableDefaultModel = {
  kind: "default";
  provider: string;
  model: string;
  reason: string;
  selected: HeadlessModelRef | undefined;
};

/** A model scope that the session did not start inside, and the model Pi chose instead. */
export type UnusableModelScope = {
  kind: "scope";
  patterns: readonly string[];
  fromCommandLine: boolean;
  reason: string;
  selected: HeadlessModelRef | undefined;
};

export type HeadlessModelProblem = UnusableDefaultModel | UnusableModelScope;

/** The settings files that set each model setting, when known. */
export type ModelSettingSources = {
  defaultProvider: string | undefined;
  defaultModel: string | undefined;
  enabledModels: string | undefined;
};

/**
 * Why the session must not run workflow steps on the model that Pi chose, or undefined when
 * the model is the one that the command line, the model scope, or the settings default chose.
 * A model scope is the user's choice, so any usable model inside it is accepted. Without a
 * scope, Pi uses a settings default only when both `defaultProvider` and `defaultModel` are
 * set, so a partial or missing default leaves Pi's first available model in place, as in an
 * interactive Pi session.
 */
export function findHeadlessModelProblem<Model extends HeadlessModelRef>(
  selection: HeadlessModelSelection<Model>,
): HeadlessModelProblem | undefined {
  if (selection.explicitModel) return undefined;
  const { scope } = selection;
  if (scope.patterns.length > 0 || scope.models.length > 0) return findScopeProblem(selection);
  return findDefaultProblem(selection);
}

function findScopeProblem<Model extends HeadlessModelRef>(
  selection: HeadlessModelSelection<Model>,
): UnusableModelScope | undefined {
  const reason = scopeReason(selection);
  if (reason === undefined) return undefined;
  const { patterns, fromCommandLine } = selection.scope;
  return { kind: "scope", patterns, fromCommandLine, reason, selected: selection.selected };
}

function scopeReason<Model extends HeadlessModelRef>(
  selection: HeadlessModelSelection<Model>,
): string | undefined {
  const { scope, selected } = selection;
  if (scope.models.length === 0) return "no model that headless pi can use matches it";
  const scoped = scope.models.find((model) => isSameModel(model, selected));
  if (scoped === undefined) return "Pi did not start on a model inside it";
  return selection.hasConfiguredAuth(scoped)
    ? undefined
    : `provider "${scoped.provider}" of the scoped model "${scoped.id}" has no configured authentication in headless pi`;
}

function findDefaultProblem<Model extends HeadlessModelRef>(
  selection: HeadlessModelSelection<Model>,
): UnusableDefaultModel | undefined {
  const { defaultProvider: provider, defaultModel: model, selected } = selection;
  if (!provider || !model) return undefined;
  const configured = selection.find(provider, model);
  if (isSameModel(selected, configured ?? { provider, id: model })) return undefined;
  const reason = defaultReason(selection, provider, model, configured) ?? "Pi did not select it";
  return { kind: "default", provider, model, reason, selected };
}

function defaultReason<Model extends HeadlessModelRef>(
  selection: HeadlessModelSelection<Model>,
  provider: string,
  model: string,
  configured: Model | undefined,
): string | undefined {
  if (configured === undefined) {
    return selection.hasProvider(provider)
      ? `provider "${provider}" has no model "${model}" in headless pi`
      : `provider "${provider}" is not available in headless pi, which loads only the pi-workflows bridge, any extension in PI_WORKFLOWS_HEADLESS_EXTENSIONS, and any extension in the server's extra Pi arguments`;
  }
  if (!selection.hasConfiguredAuth(configured)) {
    return `provider "${provider}" has no configured authentication in headless pi`;
  }
  return undefined;
}

function isSameModel(
  left: HeadlessModelRef | undefined,
  right: HeadlessModelRef | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.provider === right.provider &&
    left.id === right.id
  );
}

const LOAD_EXTENSION =
  "`PI_WORKFLOWS_HEADLESS_EXTENSIONS=/absolute/path/to/extension` or `pi-workflows server run -- -e /absolute/path/to/extension`";
const CHOOSE_MODEL = "`pi-workflows server run -- --provider <provider> --model <model>`";
// A shared server that started before the fix keeps its old list and arguments.
const RESTART =
  "The workflow server reads `PI_WORKFLOWS_HEADLESS_EXTENSIONS` and its extra Pi arguments only when it starts, so restart it with `pi-workflows server stop` after a change; `pi-workflows server status` shows the loaded `headlessExtensions`.";

/** The step failure: what was chosen, where it is set, why, what Pi chose, and what to do. */
export function describeHeadlessModelProblem(
  problem: HeadlessModelProblem,
  sources: ModelSettingSources,
): string {
  const instead =
    problem.selected === undefined
      ? "Pi found no other model"
      : `Pi would have used "${problem.selected.provider}/${problem.selected.id}" instead`;
  return [
    `${describeChoice(problem, sources)}: ${problem.reason}.`,
    `${instead}, so headless pi stopped before any model request.`,
    problem.kind === "default"
      ? `Load the provider's extension with ${LOAD_EXTENSION}, choose a model with ${CHOOSE_MODEL}, or change the default.`
      : `Load the extension of a scoped model's provider with ${LOAD_EXTENSION}, choose a model with ${CHOOSE_MODEL}, or change the scope.`,
    RESTART,
  ].join(" ");
}

function describeChoice(problem: HeadlessModelProblem, sources: ModelSettingSources): string {
  if (problem.kind === "default") {
    return `Headless pi cannot run workflow steps on the default model "${problem.provider}/${problem.model}" from Pi settings${describeDefaultSources(sources)}`;
  }
  const patterns = problem.patterns.map((pattern) => `"${pattern}"`).join(", ");
  const origin = problem.fromCommandLine
    ? "`--models` in the server's extra Pi arguments"
    : `the \`enabledModels\` Pi setting${sources.enabledModels === undefined ? "" : ` in ${sources.enabledModels}`}`;
  return `Headless pi cannot run workflow steps inside the model scope ${patterns} from ${origin}`;
}

function describeDefaultSources(sources: ModelSettingSources): string {
  const { defaultProvider, defaultModel } = sources;
  if (defaultProvider !== undefined && defaultProvider === defaultModel) {
    return ` (set in ${defaultProvider})`;
  }
  const parts = [
    defaultProvider === undefined ? undefined : `defaultProvider in ${defaultProvider}`,
    defaultModel === undefined ? undefined : `defaultModel in ${defaultModel}`,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
}
