/**
 * The model check that the rpc-bridge runs when a headless agent step's Pi child starts.
 *
 * Headless pi starts with `--no-extensions`, so the default model in Pi settings can name a
 * provider that only an unloaded user extension registers. Pi's `findInitialModel` then falls
 * back to the first available model without any diagnostic, and the step would run on a model
 * that nobody chose. Pi exits on an explicit `--model` that it cannot resolve, so only the
 * settings default needs this check. This module has no host imports, so unit tests and the
 * bridge share it.
 */

export type HeadlessModelRef = { provider: string; id: string };

/** What the bridge sees of the child's model selection at session start. */
export type HeadlessModelSelection<Model extends HeadlessModelRef = HeadlessModelRef> = {
  /** Pi's command line names a model with `--model`. Pi resolves it or exits. */
  explicitModel: boolean;
  /** `defaultProvider` from the session's effective Pi settings. */
  defaultProvider: string | undefined;
  /** `defaultModel` from the session's effective Pi settings. */
  defaultModel: string | undefined;
  /** The model that the session starts on. */
  selected: HeadlessModelRef | undefined;
  /** The session's model scope from `--models` or `enabledModels`. */
  scoped: readonly HeadlessModelRef[];
  /** Look a model up in the child's model catalog. */
  find(provider: string, id: string): Model | undefined;
  /** Whether the child's catalog has any model of `provider`. */
  hasProvider(provider: string): boolean;
  /** Whether the child has authentication configured for the provider of `model`. */
  hasConfiguredAuth(model: Model): boolean;
};

/** A settings default that the child could not use, and the model Pi chose instead. */
export type UnusableDefaultModel = {
  provider: string;
  model: string;
  reason: string;
  selected: HeadlessModelRef | undefined;
};

/** The settings files that set each default field, when known. */
export type DefaultModelSources = {
  defaultProvider: string | undefined;
  defaultModel: string | undefined;
};

/**
 * The settings default that Pi could not use, or undefined when the session runs on the model
 * that its command line or settings chose. Pi uses a settings default only when both
 * `defaultProvider` and `defaultModel` are set, so a partial or missing default leaves Pi's
 * first available model in place, as in an interactive Pi session.
 */
export function findUnusableDefaultModel<Model extends HeadlessModelRef>(
  selection: HeadlessModelSelection<Model>,
): UnusableDefaultModel | undefined {
  const { defaultProvider: provider, defaultModel: model, selected } = selection;
  if (selection.explicitModel || !provider || !model) return undefined;
  const configured = selection.find(provider, model);
  if (isSameModel(selected, configured ?? { provider, id: model })) return undefined;
  const reason = unusableReason(selection, provider, model, configured);
  if (reason === undefined && isOutOfScope(selection.scoped, configured)) return undefined;
  return { provider, model, reason: reason ?? "Pi did not select it", selected };
}

/**
 * A usable default outside the configured model scope. Pi deliberately starts on the first
 * scoped model then, as it does in an interactive session.
 */
function isOutOfScope(
  scoped: readonly HeadlessModelRef[],
  configured: HeadlessModelRef | undefined,
): boolean {
  return scoped.length > 0 && !scoped.some((model) => isSameModel(model, configured));
}

function unusableReason<Model extends HeadlessModelRef>(
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

/** The step failure for an unusable default: what, where it is set, why, and what to do. */
export function describeUnusableDefaultModel(
  unusable: UnusableDefaultModel,
  sources: DefaultModelSources,
): string {
  const instead =
    unusable.selected === undefined
      ? "Pi found no other model"
      : `Pi would have used "${unusable.selected.provider}/${unusable.selected.id}" instead`;
  return [
    `Headless pi cannot run workflow steps on the default model "${unusable.provider}/${unusable.model}" from Pi settings${describeSources(sources)}: ${unusable.reason}.`,
    `${instead}, so headless pi stopped before any model request.`,
    "Load the provider's extension with `PI_WORKFLOWS_HEADLESS_EXTENSIONS=/absolute/path/to/extension` or `pi-workflows server run -- -e /absolute/path/to/extension`, choose a model with `pi-workflows server run -- --provider <provider> --model <model>`, or change the default.",
    // A shared server that started before the fix keeps its old list and arguments.
    "The workflow server reads `PI_WORKFLOWS_HEADLESS_EXTENSIONS` and its extra Pi arguments only when it starts, so restart it with `pi-workflows server stop` after a change; `pi-workflows server status` shows the loaded `headlessExtensions`.",
  ].join(" ");
}

function describeSources(sources: DefaultModelSources): string {
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
