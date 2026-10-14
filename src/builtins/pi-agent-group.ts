import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  DefaultPackageManager,
  DefaultResourceLoader,
  ExtensionRunner,
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type LoadExtensionsResult,
  type ResolvedResource,
} from "@earendil-works/pi-coding-agent";
import { PROMPT_CEILING_CHARS } from "../workflows/prompt-evidence.js";
import {
  PiAgentGroupError,
  type PiAgentGroupLaunchOptions,
  type PiAgentLifecycleEvent,
  type PiAgentLifecycleState,
  type PiAgentRequest,
  type PiAgentResult,
  type PiAgentThinkingLevel,
  type PiAgentTool,
} from "./pi-agent-launch.js";

// This module imports packages that only Pi supplies. Only processes that Pi starts may load
// it: the agent group bridge that the workflow runner starts inside headless Pi, and tests.
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const MAX_AGENTS = 8;
const MAX_CONCURRENCY = 8;
const DEFAULT_FINAL_CHARS = 256_000;
const MAX_FINAL_CHARS = 1_000_000;
const DEFAULT_TIMEOUT_MS = 15 * 60_000;
const MAX_TIMEOUT_MS = 60 * 60_000;
const MAX_PHASE_UPDATES = 64;
const MIN_PHASE_INTERVAL_MS = 250;
const BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls"]);
const RESERVED_EXTENSION_NAMES = new Set([
  "workflow",
  "piw",
  "resource-manager",
  "workflow-update",
  "workflow-answer",
  "workflow-submit",
  "workflow-pause",
  "workflow-resume",
  "workflow-cancel",
]);
const CREDENTIALS_LOAD_FAILURE = "Could not load Pi credentials for isolated agents";
const MODELS_LOAD_FAILURE = "Could not load Pi model catalog for isolated agents";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type PiAgentEvent = Record<string, unknown>;

/**
 * How Pi dispatched an accepted prompt. Pi reports no disposition for a rejected
 * prompt, and only a `started` prompt runs the model.
 */
type PromptDisposition = "started" | "handled" | "queued";

type PiAgentSession = {
  prompt(
    text: string,
    options?: { preflightResult?: (disposition: PromptDisposition) => void },
  ): Promise<void>;
  subscribe(listener: (event: PiAgentEvent) => void): () => void;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  model: { provider: string; id: string } | undefined;
  thinkingLevel: PiAgentThinkingLevel;
};

export type PiAgentSessionFactory = (
  request: PiAgentRequest,
  context: { signal: AbortSignal },
) => Promise<PiAgentSession>;

export type PiAgentGroupOptions = PiAgentGroupLaunchOptions & {
  sessionFactory?: PiAgentSessionFactory;
  now?: () => number;
};

/**
 * Run one isolated agent group. Every error it throws is a `PiAgentGroupError` of this module,
 * so {@link agentGroupErrorFields} can tell Pi Workflows' own facts from foreign text.
 */
export async function runPiAgentGroup(
  input: PiAgentRequest[],
  options: PiAgentGroupOptions,
): Promise<PiAgentResult[]> {
  try {
    return await runGroupRequests(input, options);
  } catch (error) {
    throw groupBoundaryError(error);
  }
}

/**
 * The safe fields of an error that this module raised, or `undefined` for any other value.
 *
 * The check is `instanceof` against the `PiAgentGroupError` class that this module itself
 * imports, so it holds in whatever module copy a loader made: the bridge imports this function
 * from the same module as {@link runPiAgentGroup}. A foreign error that only copies the name
 * and fields of an agent error is not an instance, so its text never becomes facts.
 */
export function agentGroupErrorFields(
  error: unknown,
): { agentId: string; code: string; facts: string; detail?: string } | undefined {
  if (!(error instanceof PiAgentGroupError)) return undefined;
  return {
    agentId: error.agentId,
    code: error.code,
    facts: error.facts,
    ...(error.detail === undefined ? {} : { detail: error.detail }),
  };
}

/**
 * Errors from preparing a group, such as a Pi SDK, settings, package manager, or extension
 * failure, can be any value. Only this module's own agent errors pass; anything else keeps its
 * text as private detail.
 */
function groupBoundaryError(error: unknown): PiAgentGroupError {
  if (error instanceof PiAgentGroupError) return error;
  return new PiAgentGroupError("group", "failed", "the agent group raised an error", {
    detail: errorMessage(error),
  });
}

async function runGroupRequests(
  input: PiAgentRequest[],
  options: PiAgentGroupOptions,
): Promise<PiAgentResult[]> {
  const { requests, maxFinalChars } = validatedGroup(input, options);
  if (requests.length === 0) return [];
  if (options.signal.aborted) throw cancellationError("group", options.signal.reason);

  const groupPlan =
    options.sessionFactory === undefined
      ? await createSdkGroupPlan(requests, options.behaviorExtensionPaths ?? [], options.signal)
      : undefined;
  if (options.signal.aborted) throw cancellationError("group", options.signal.reason);
  const sessionFactory =
    options.sessionFactory ??
    (async (request: PiAgentRequest, context: { signal: AbortSignal }) =>
      await createSdkSession(request, groupPlan!, context.signal));
  const internalAbort = new AbortController();
  const signal = AbortSignal.any([options.signal, internalAbort.signal]);
  const results = Array.from<PiAgentResult | undefined>({ length: requests.length });
  const started = new Set<number>();
  let nextIndex = 0;
  let primary: { index: number; error: unknown } | undefined;

  const runSlot = async () => {
    while (!signal.aborted) {
      const index = nextIndex;
      if (index >= requests.length) return;
      nextIndex += 1;
      started.add(index);
      try {
        results[index] = await runOneAgent(requests[index]!, {
          ...options,
          maxFinalChars,
          signal,
          sessionFactory,
        });
      } catch (error) {
        if (primary === undefined && !options.signal.aborted) {
          primary = { index, error };
          if (options.failFast !== false) internalAbort.abort(error);
        }
        if (options.failFast !== false) return;
      }
    }
  };

  const runnerCount = Math.min(options.maxConcurrency, requests.length);
  await Promise.all(Array.from({ length: runnerCount }, runSlot));

  if (options.signal.aborted) throw cancellationError("group", options.signal.reason);
  if (primary !== undefined) {
    await publishQueuedCancellations(requests, started, options);
    throw primary.error;
  }
  return results as PiAgentResult[];
}

type ModelRuntimeCreateOptions = NonNullable<Parameters<typeof ModelRuntime.create>[0]>;
type CredentialStore = NonNullable<ModelRuntimeCreateOptions["credentials"]>;
type Credential = Awaited<ReturnType<CredentialStore["read"]>>;
type StoredCredential = Exclude<Credential, undefined>;
type ModelStore = NonNullable<ModelRuntimeCreateOptions["modelsStore"]>;
type ModelStoreEntry = Awaited<ReturnType<ModelStore["read"]>>;
type StoredModelStoreEntry = Exclude<ModelStoreEntry, undefined>;

export async function createEphemeralCredentialStore(
  signal: AbortSignal,
): Promise<CredentialStore> {
  signal.throwIfAborted();
  // A parse error can quote the file, and so a credential, so its text is not kept anywhere.
  const source = await readAgentJson(
    path.join(getAgentDir(), "auth.json"),
    CREDENTIALS_LOAD_FAILURE,
    false,
  );
  const entries = parseCredentialEntries(source);
  const pending = new Map<string, Promise<Credential>>();
  const enqueue = (
    providerId: string,
    operation: () => Promise<Credential>,
  ): Promise<Credential> => {
    const work = (pending.get(providerId) ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then(operation);
    pending.set(providerId, work);
    const release = () => {
      if (pending.get(providerId) === work) pending.delete(providerId);
    };
    void work.then(release, release);
    return work;
  };
  return {
    async read(providerId) {
      signal.throwIfAborted();
      return cloneCredential(entries.get(providerId));
    },
    async list() {
      signal.throwIfAborted();
      return [...entries].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(providerId, update) {
      return await enqueue(providerId, async () => {
        signal.throwIfAborted();
        const current = entries.get(providerId);
        const next = await update(cloneCredential(current));
        signal.throwIfAborted();
        if (next !== undefined) entries.set(providerId, cloneCredential(next)!);
        return cloneCredential(entries.get(providerId));
      });
    },
    async delete(providerId) {
      await enqueue(providerId, async () => {
        signal.throwIfAborted();
        entries.delete(providerId);
        return undefined;
      });
    },
  };
}

function parseCredentialEntries(source: unknown): Map<string, StoredCredential> {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw loadFailure(CREDENTIALS_LOAD_FAILURE);
  }
  const entries = new Map<string, StoredCredential>();
  for (const [providerId, value] of Object.entries(source)) {
    if (!isStoredCredential(value)) {
      throw loadFailure(CREDENTIALS_LOAD_FAILURE);
    }
    entries.set(providerId, cloneCredential(value)!);
  }
  return entries;
}

function isStoredCredential(value: unknown): value is StoredCredential {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const credential = value as Record<string, unknown>;
  if (credential.type === "api_key") {
    return credential.key === undefined || typeof credential.key === "string";
  }
  return (
    credential.type === "oauth" &&
    typeof credential.refresh === "string" &&
    typeof credential.access === "string" &&
    typeof credential.expires === "number"
  );
}

function cloneCredential(value: StoredCredential | undefined): Credential {
  return value === undefined ? undefined : structuredClone(value);
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

/**
 * A failure of Pi Workflows' own loading. The fixed sentence is the message's facts. The text of
 * an underlying filesystem or parser error is not Pi Workflows' own, so it is private detail.
 */
function loadFailure(facts: string, cause?: unknown): PiAgentGroupError {
  return new PiAgentGroupError(
    "group",
    "failed",
    facts,
    cause === undefined ? {} : { detail: errorMessage(cause) },
  );
}

/** A JSON file in Pi's agent directory. A missing file reads as an empty object. */
async function readAgentJson(
  file: string,
  failure: string,
  keepParseError: boolean,
): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (isMissingFile(error)) return {};
    throw loadFailure(failure, error);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw loadFailure(failure, keepParseError ? error : undefined);
  }
}

export async function createEphemeralModelStore(signal: AbortSignal): Promise<ModelStore> {
  signal.throwIfAborted();
  const source = await readAgentJson(
    path.join(getAgentDir(), "models-store.json"),
    MODELS_LOAD_FAILURE,
    true,
  );
  const entries = parseModelStoreEntries(source);
  return {
    async read(providerId) {
      signal.throwIfAborted();
      const entry = entries.get(providerId);
      return entry === undefined ? undefined : structuredClone(entry);
    },
    async write(providerId, entry) {
      signal.throwIfAborted();
      entries.set(providerId, structuredClone(entry));
    },
    async delete(providerId) {
      signal.throwIfAborted();
      entries.delete(providerId);
    },
  };
}

function parseModelStoreEntries(source: unknown): Map<string, StoredModelStoreEntry> {
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw loadFailure(MODELS_LOAD_FAILURE);
  }
  const entries = new Map<string, StoredModelStoreEntry>();
  for (const [providerId, value] of Object.entries(source)) {
    if (!isModelStoreEntry(value)) {
      throw loadFailure(MODELS_LOAD_FAILURE);
    }
    entries.set(providerId, structuredClone(value));
  }
  return entries;
}

function isModelStoreEntry(value: unknown): value is StoredModelStoreEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    Array.isArray(entry.models) &&
    (entry.lastModified === undefined || typeof entry.lastModified === "number") &&
    (entry.checkedAt === undefined || typeof entry.checkedAt === "number") &&
    (entry.etag === undefined || typeof entry.etag === "string")
  );
}

type PiAgentDispatch = {
  provider: string;
  modelId: string;
  thinkingLevel: PiAgentThinkingLevel;
};

type CredentialSnapshot = Map<string, StoredCredential>;

type SdkGroupPlan = {
  agentDir: string;
  cwd: string;
  dispatch: PiAgentDispatch;
  extensionPaths: readonly string[];
  /** An admitted extension registers the dispatch provider. Otherwise Pi itself defines it. */
  providerExtension: boolean;
  credentialSnapshot: CredentialSnapshot;
  /** The dispatch provider's cached catalog entry, when Pi has saved one. */
  modelSnapshot: StoredModelStoreEntry | undefined;
};

type ExtensionCandidate = {
  path: string;
  source: string;
};

type ChildExtensionProfile = {
  extensionPaths: readonly string[];
  providerExtension: boolean;
};

async function createSdkGroupPlan(
  requests: PiAgentRequest[],
  behaviorExtensionPaths: string[],
  signal: AbortSignal,
): Promise<SdkGroupPlan> {
  signal.throwIfAborted();
  const cwd = requests[0]!.cwd;
  if (requests.some((request) => request.cwd !== cwd)) {
    throw invalidRequest("the requests must use one working directory");
  }
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const dispatch = resolveGroupDispatch(requests, settingsManager);
  const profile = await resolveChildExtensionProfile(
    cwd,
    agentDir,
    settingsManager,
    dispatch.provider,
    behaviorExtensionPaths,
    signal,
  );
  if (!profile.providerExtension) await assertPiProvider(dispatch.provider, signal);
  const credentials = await createEphemeralCredentialStore(signal);
  // Children receive only the dispatch provider's stored credential. Pi resolves a provider's
  // authentication from its own entry, and the dispatch is the only provider a child may use.
  const credential = await credentials.read(dispatch.provider);
  const credentialSnapshot: CredentialSnapshot = new Map(
    credential === undefined ? [] : [[dispatch.provider, credential]],
  );
  // The cached catalog is optional. Providers built into Pi and providers that declare their
  // models resolve without it, so a group also runs offline before any catalog refresh.
  const models = await createEphemeralModelStore(signal);
  const modelSnapshot = await models.read(dispatch.provider);
  signal.throwIfAborted();
  return {
    agentDir,
    cwd,
    dispatch,
    ...profile,
    credentialSnapshot,
    modelSnapshot,
  };
}

/**
 * A dispatch provider that no admitted extension registers must be one that Pi defines
 * itself: built into Pi or configured in `models.json`.
 */
async function assertPiProvider(provider: string, signal: AbortSignal): Promise<void> {
  const modelRuntime = await offlineModelRuntime(signal);
  if (modelRuntime.getProvider(provider) === undefined) {
    throw new PiAgentGroupError("group", "has unknown provider", provider);
  }
}

function resolveGroupDispatch(
  requests: PiAgentRequest[],
  settingsManager: SettingsManager,
): PiAgentDispatch {
  const overrides = requests.map((request) => ({
    model: request.model,
    thinkingLevel: request.thinkingLevel,
  }));
  const hasAnyOverride = overrides.some(
    ({ model, thinkingLevel }) => model !== undefined || thinkingLevel !== undefined,
  );
  if (hasAnyOverride) {
    for (const [index, override] of overrides.entries()) {
      if (override.model === undefined || override.thinkingLevel === undefined) {
        throw invalidRequest(
          `Pi agent ${requests[index]!.id} must override model and thinkingLevel together`,
        );
      }
    }
    const first = overrides[0]!;
    if (
      overrides.some(
        (override) =>
          override.model!.provider !== first.model!.provider ||
          override.model!.id !== first.model!.id ||
          override.thinkingLevel !== first.thinkingLevel,
      )
    ) {
      throw invalidRequest("the requests must use one exact model dispatch");
    }
    return {
      provider: first.model!.provider,
      modelId: first.model!.id,
      thinkingLevel: first.thinkingLevel!,
    };
  }
  const provider = settingsManager.getDefaultProvider();
  const modelId = settingsManager.getDefaultModel();
  const thinkingLevel = settingsManager.getDefaultThinkingLevel();
  if (provider === undefined || modelId === undefined || thinkingLevel === undefined) {
    throw new PiAgentGroupError(
      "group",
      "has no default model",
      "configure a default provider, model, and thinking level in Pi",
    );
  }
  return { provider, modelId, thinkingLevel };
}

async function resolveChildExtensionProfile(
  cwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  provider: string,
  behaviorExtensionPaths: string[],
  signal: AbortSignal,
): Promise<ChildExtensionProfile> {
  signal.throwIfAborted();
  const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const resolved = await packageManager.resolve(async () => "skip");
  const candidates = new Map<string, ExtensionCandidate>();
  for (const resource of resolved.extensions) {
    if (!resource.enabled || resource.metadata.scope !== "user") continue;
    const candidate = await extensionCandidate(resource, signal);
    if (candidate !== undefined) candidates.set(candidate.path, candidate);
  }
  const behaviorPaths = await canonicalizeBehaviorPaths(behaviorExtensionPaths, signal);
  for (const candidate of behaviorPaths) candidates.set(candidate.path, candidate);
  if (candidates.size === 0) return { extensionPaths: Object.freeze([]), providerExtension: false };

  const candidateList = [...candidates.values()].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
    additionalExtensionPaths: candidateList.map((candidate) => candidate.path),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => undefined,
    appendSystemPromptOverride: () => [],
  });
  let result: LoadExtensionsResult | undefined;
  let profile: ChildExtensionProfile | undefined;
  let failure: unknown;
  try {
    await loader.reload();
    result = loader.getExtensions();
    if (result.errors.length > 0) {
      throw new PiAgentGroupError("group", "could not load provider extensions", "load failed");
    }
    const byPath = new Map(
      await Promise.all(
        result.extensions.map(
          async (extension) =>
            [await canonicalPath(extension.resolvedPath, signal), extension] as const,
        ),
      ),
    );
    const owners = new Set<string>();
    for (const registration of result.runtime.pendingNativeProviderRegistrations) {
      if (registration.provider.id === provider) {
        owners.add(await canonicalPath(registration.extensionPath, signal));
      }
    }
    for (const registration of result.runtime.pendingProviderRegistrations) {
      if (registration.name === provider) {
        owners.add(await canonicalPath(registration.extensionPath, signal));
      }
    }
    if (owners.size > 1) {
      throw new PiAgentGroupError("group", "has competing provider extensions", provider);
    }
    // Without an owner, the child loads no provider extension and uses Pi's own provider.
    const providerPath = [...owners][0];
    if (
      providerPath !== undefined &&
      (!candidates.has(providerPath) || !byPath.has(providerPath))
    ) {
      throw new PiAgentGroupError("group", "has invalid provider extension", provider);
    }
    const admitted = new Set([
      ...(providerPath === undefined ? [] : [providerPath]),
      ...behaviorPaths.map((candidate) => candidate.path),
    ]);
    for (const admittedPath of admitted) {
      const extension = byPath.get(admittedPath);
      if (extension === undefined) {
        throw new PiAgentGroupError("group", "could not load admitted extension", "load failed");
      }
      validateAdmittedExtension(extension, candidates.get(admittedPath)?.source ?? "extension");
    }
    profile = {
      extensionPaths: Object.freeze([...admitted].toSorted()),
      providerExtension: providerPath !== undefined,
    };
  } catch (error) {
    failure = error;
  }
  if (result !== undefined) {
    try {
      await shutdownLoadedExtensions(result, cwd, signal);
    } catch {
      failure ??= new PiAgentGroupError(
        "group",
        "could not settle extension preflight",
        "cleanup failed",
      );
    } finally {
      result.runtime.invalidate("Pi agent extension preflight finished");
    }
  }
  if (failure !== undefined) throw failure;
  return profile!;
}

/** A model runtime with Pi's own providers and no credentials, cache, or network. */
async function offlineModelRuntime(signal: AbortSignal): Promise<ModelRuntime> {
  return await ModelRuntime.create({
    allowModelNetwork: false,
    refreshOnCreate: false,
    signal,
    credentials: credentialStoreFromSnapshot(new Map(), signal),
    modelsStore: emptyModelStore(signal),
  });
}

async function shutdownLoadedExtensions(
  result: LoadExtensionsResult,
  cwd: string,
  signal: AbortSignal,
): Promise<void> {
  const modelRuntime = await offlineModelRuntime(signal);
  const runner = new ExtensionRunner(
    result.extensions,
    result.runtime,
    cwd,
    SessionManager.inMemory(cwd),
    new ModelRegistry(modelRuntime),
  );
  runner.setUIContext(undefined, "print");
  let failed = false;
  const unsubscribe = runner.onError(() => {
    failed = true;
  });
  try {
    await runner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    unsubscribe();
  }
  if (failed) throw new Error("extension preflight cleanup failed");
}

function emptyModelStore(signal: AbortSignal): ModelStore {
  return {
    async read() {
      signal.throwIfAborted();
      return undefined;
    },
    async write() {
      signal.throwIfAborted();
    },
    async delete() {
      signal.throwIfAborted();
    },
  };
}

async function extensionCandidate(
  resource: ResolvedResource,
  signal: AbortSignal,
): Promise<ExtensionCandidate | undefined> {
  const resolvedPath = await canonicalPath(resource.path, signal);
  if (await isPiWorkflowsExtension(resolvedPath, resource, signal)) return undefined;
  return { path: resolvedPath, source: resource.metadata.source };
}

async function canonicalizeBehaviorPaths(
  values: string[],
  signal: AbortSignal,
): Promise<ExtensionCandidate[]> {
  const result = new Map<string, ExtensionCandidate>();
  for (const value of values) {
    operationalText(value, "Pi agent behavior extension path", 4_000);
    const resolvedPath = await canonicalPath(value, signal);
    if (await isPiWorkflowsExtension(resolvedPath, undefined, signal)) {
      throw invalidRequest("Pi Workflows cannot be admitted as a child extension");
    }
    result.set(resolvedPath, { path: resolvedPath, source: "explicit behavior extension" });
  }
  return [...result.values()].toSorted((left, right) => left.path.localeCompare(right.path));
}

async function canonicalPath(value: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  try {
    return await fs.realpath(path.resolve(value));
  } catch (error) {
    throw loadFailure("Could not resolve Pi child extension path", error);
  }
}

async function isPiWorkflowsExtension(
  extensionPath: string,
  resource: ResolvedResource | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    isUnder(extensionPath, path.join(PACKAGE_ROOT, "src", "extension")) ||
    isUnder(extensionPath, path.join(PACKAGE_ROOT, "dist", "extension"))
  ) {
    return true;
  }
  if (resource?.metadata.source.includes("@osolmaz/pi-workflows")) return true;
  let directory = resource?.metadata.baseDir ?? path.dirname(extensionPath);
  for (let depth = 0; depth < 8; depth += 1) {
    signal.throwIfAborted();
    const manifestPath = path.join(directory, "package.json");
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
      if (isPiWorkflowsManifest(manifest, directory, extensionPath)) return true;
      return false;
    } catch (error) {
      if (!isMissingFile(error)) return false;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
  return false;
}

function isPiWorkflowsManifest(
  value: unknown,
  packageDirectory: string,
  extensionPath: string,
): boolean {
  if (!isRecord(value)) return false;
  let ownsPiWorkflows = value.name === "@osolmaz/pi-workflows";
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    if (isRecord(value[field]) && "@osolmaz/pi-workflows" in value[field]) {
      ownsPiWorkflows = true;
    }
  }
  if (!ownsPiWorkflows || !isRecord(value.pi) || !Array.isArray(value.pi.extensions)) {
    return false;
  }
  return value.pi.extensions.some(
    (entry) =>
      typeof entry === "string" &&
      path.resolve(packageDirectory, entry.replace(/\*+$/, "")) === extensionPath,
  );
}

function isUnder(value: string, parent: string): boolean {
  const relative = path.relative(parent, value);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateAdmittedExtension(
  extension: LoadExtensionsResult["extensions"][number],
  source: string,
): void {
  for (const name of extension.tools.keys()) {
    if (BUILTIN_TOOLS.has(name)) {
      throw new PiAgentGroupError("group", "provider extension replaces a built-in tool", source);
    }
    if (isReservedExtensionName(name)) {
      throw new PiAgentGroupError("group", "provider extension exposes workflow control", source);
    }
  }
  for (const name of extension.commands.keys()) {
    if (isReservedExtensionName(name)) {
      throw new PiAgentGroupError("group", "provider extension exposes workflow control", source);
    }
  }
  if (extension.handlers.has("resources_discover")) {
    throw new PiAgentGroupError("group", "provider extension discovers child resources", source);
  }
}

function isReservedExtensionName(value: string): boolean {
  const name = value.toLowerCase();
  return (
    RESERVED_EXTENSION_NAMES.has(name) ||
    name.startsWith("workflow-") ||
    name.startsWith("workflow:")
  );
}

function credentialStoreFromSnapshot(
  snapshot: CredentialSnapshot,
  signal: AbortSignal,
): CredentialStore {
  const entries = new Map(
    [...snapshot].map(([providerId, credential]) => [providerId, cloneCredential(credential)!]),
  );
  const pending = new Map<string, Promise<Credential>>();
  const enqueue = (
    providerId: string,
    operation: () => Promise<Credential>,
  ): Promise<Credential> => {
    const work = (pending.get(providerId) ?? Promise.resolve(undefined))
      .catch(() => undefined)
      .then(operation);
    pending.set(providerId, work);
    const release = () => {
      if (pending.get(providerId) === work) pending.delete(providerId);
    };
    void work.then(release, release);
    return work;
  };
  return {
    async read(providerId) {
      signal.throwIfAborted();
      return cloneCredential(entries.get(providerId));
    },
    async list() {
      signal.throwIfAborted();
      return [...entries].map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      }));
    },
    async modify(providerId, update) {
      return await enqueue(providerId, async () => {
        signal.throwIfAborted();
        const next = await update(cloneCredential(entries.get(providerId)));
        signal.throwIfAborted();
        if (next !== undefined) entries.set(providerId, cloneCredential(next)!);
        return cloneCredential(entries.get(providerId));
      });
    },
    async delete(providerId) {
      await enqueue(providerId, async () => {
        signal.throwIfAborted();
        entries.delete(providerId);
        return undefined;
      });
    },
  };
}

function modelStoreFromSnapshot(
  provider: string,
  snapshot: StoredModelStoreEntry | undefined,
  signal: AbortSignal,
): ModelStore {
  const entries = new Map<string, StoredModelStoreEntry>(
    snapshot === undefined ? [] : [[provider, structuredClone(snapshot)]],
  );
  return {
    async read(providerId) {
      signal.throwIfAborted();
      const entry = entries.get(providerId);
      return entry === undefined ? undefined : structuredClone(entry);
    },
    async write(providerId, entry) {
      signal.throwIfAborted();
      entries.set(providerId, structuredClone(entry));
    },
    async delete(providerId) {
      signal.throwIfAborted();
      entries.delete(providerId);
    },
  };
}

type RunOneOptions = PiAgentGroupOptions & {
  signal: AbortSignal;
  sessionFactory: PiAgentSessionFactory;
};

async function runOneAgent(
  request: PiAgentRequest,
  options: RunOneOptions,
): Promise<PiAgentResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const lifecycle = lifecyclePublisher(request, startedAt, options);
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let session: PiAgentSession | undefined;
  let unsubscribe: (() => void) | undefined;
  let finalMessage: Record<string, unknown> | undefined;
  let preflightDisposition: PromptDisposition | undefined;
  let abortKind: "timeout" | "cancelled" | undefined;
  let abortFailure: unknown;
  let abortWork = Promise.resolve();
  let result: PiAgentResult | undefined;
  let failure: unknown;

  const abortSession = (kind: "timeout" | "cancelled") => {
    abortKind ??= kind;
    if (session !== undefined) {
      abortWork = abortWork
        .then(async () => await session?.abort())
        .catch((error) => {
          abortFailure = error;
        });
    }
  };
  const onAbort = () => abortSession("cancelled");
  const timeout = setTimeout(() => abortSession("timeout"), timeoutMs);
  options.signal.addEventListener("abort", onAbort, { once: true });

  lifecycle.emit("running", "starting");
  try {
    if (options.signal.aborted) throw cancellationError(request.id, options.signal.reason);
    session = await options.sessionFactory(request, { signal: options.signal });
    const model = modelName(session.model);
    lifecycle.setDispatch(model, session.thinkingLevel);
    lifecycle.emit("running", "starting", true);
    unsubscribe = session.subscribe((event) => {
      const phase = eventPhase(event, request.tools);
      if (phase !== undefined) lifecycle.emit("running", phase);
      const message = assistantMessage(event);
      if (message !== undefined) finalMessage = message;
    });
    if (abortKind !== undefined || options.signal.aborted) {
      abortSession(abortKind ?? "cancelled");
      await abortWork;
      throw stoppedError(request.id, abortKind, timeoutMs, options.signal, abortFailure);
    }

    await session.prompt(request.prompt, {
      preflightResult: (disposition) => {
        preflightDisposition = disposition;
      },
    });
    await abortWork;
    if (abortKind !== undefined || options.signal.aborted) {
      throw stoppedError(request.id, abortKind, timeoutMs, options.signal, abortFailure);
    }
    if (preflightDisposition !== "started") {
      throw new PiAgentGroupError(
        request.id,
        "rejected prompt",
        preflightDisposition === undefined
          ? "prompt preflight failed"
          : `Pi ${preflightDisposition} the prompt without running the model`,
      );
    }
    lifecycle.emit("running", "finalizing", true);
    const text = finalAssistantText(request.id, finalMessage, options.maxFinalChars!);
    result = {
      id: request.id,
      text,
      model,
      thinkingLevel: session.thinkingLevel,
      durationMs: Math.max(0, now() - startedAt),
    };
  } catch (error) {
    failure = normalizeAgentError(request.id, error, abortKind, timeoutMs, options.signal);
  } finally {
    clearTimeout(timeout);
    options.signal.removeEventListener("abort", onAbort);
    unsubscribe?.();
    if (session !== undefined && abortKind !== undefined) await abortWork;
    try {
      await session?.dispose();
    } catch (error) {
      failure ??=
        error instanceof PiAgentGroupError
          ? error
          : new PiAgentGroupError(
              request.id,
              "cleanup failed",
              "the session could not be disposed",
              {
                detail: errorMessage(error),
              },
            );
    }
    const state = terminalState(failure);
    lifecycle.emit(state, state, true);
    await lifecycle.flush();
  }
  if (failure !== undefined) throw failure;
  return result!;
}

function lifecyclePublisher(
  request: PiAgentRequest,
  startedAt: number,
  options: RunOneOptions,
): {
  emit(state: PiAgentLifecycleState, phase: string, force?: boolean): void;
  setDispatch(model: string, thinkingLevel: PiAgentThinkingLevel): void;
  flush(): Promise<void>;
} {
  const now = options.now ?? Date.now;
  let model: string | undefined;
  let thinkingLevel: PiAgentThinkingLevel | undefined;
  let previous = "";
  let previousAt = -Infinity;
  let phaseUpdates = 0;
  let work = Promise.resolve();
  const emit = (state: PiAgentLifecycleState, phase: string, force = false) => {
    const at = now();
    const key = `${state}:${phase}:${model ?? ""}`;
    if (!force && (key === previous || at - previousAt < MIN_PHASE_INTERVAL_MS)) return;
    if (!force && phaseUpdates >= MAX_PHASE_UPDATES) return;
    previous = key;
    previousAt = at;
    phaseUpdates += 1;
    if (options.onLifecycle === undefined) return;
    const event: PiAgentLifecycleEvent = {
      id: request.id,
      role: request.role,
      state,
      phase,
      elapsedMs: Math.max(0, at - startedAt),
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
    };
    work = work.then(async () => await options.onLifecycle?.(event)).catch(() => undefined);
  };
  return {
    emit,
    setDispatch(value, thinking) {
      model = value;
      thinkingLevel = thinking;
    },
    async flush() {
      await work;
    },
  };
}

async function createSdkSession(
  request: PiAgentRequest,
  plan: SdkGroupPlan,
  signal: AbortSignal,
): Promise<PiAgentSession> {
  if (signal.aborted) throw cancellationError(request.id, signal.reason);
  let latestExtensions: LoadExtensionsResult | undefined;
  const runtime = await createAgentSessionRuntime(
    async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
      const settingsManager = SettingsManager.inMemory(
        {
          defaultProvider: plan.dispatch.provider,
          defaultModel: plan.dispatch.modelId,
          defaultThinkingLevel: plan.dispatch.thinkingLevel,
          extensions: [],
          skills: [],
          prompts: [],
          themes: [],
        },
        { projectTrusted: false },
      );
      // Skip the create-time refresh: createAgentSessionServices refreshes once, offline,
      // after it registers the admitted provider extension.
      const modelRuntime = await ModelRuntime.create({
        allowModelNetwork: false,
        refreshOnCreate: false,
        signal,
        credentials: credentialStoreFromSnapshot(plan.credentialSnapshot, signal),
        modelsStore: modelStoreFromSnapshot(plan.dispatch.provider, plan.modelSnapshot, signal),
      });
      try {
        const services = await createAgentSessionServices({
          cwd,
          agentDir,
          settingsManager,
          modelRuntime,
          modelRuntimeSignal: signal,
          resourceLoaderOptions: {
            additionalExtensionPaths: [...plan.extensionPaths],
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            systemPromptOverride: () => undefined,
            appendSystemPromptOverride: () => [],
          },
        });
        latestExtensions = services.resourceLoader.getExtensions();
        assertLoadedProfile(request.id, latestExtensions, plan.extensionPaths);
        assertProviderRegistration(request.id, services, plan);
        const model = dispatchModel(request.id, services.modelRuntime, plan.dispatch);
        const sessionResult = await createAgentSessionFromServices({
          services,
          sessionManager,
          ...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
          tools: request.tools,
          model,
          thinkingLevel: plan.dispatch.thinkingLevel,
        });
        return {
          ...sessionResult,
          services,
          diagnostics: services.diagnostics,
        };
      } catch (error) {
        if (latestExtensions !== undefined) {
          try {
            await shutdownLoadedExtensions(latestExtensions, cwd, new AbortController().signal);
          } catch {
            // Preserve the child setup error as the primary failure.
          } finally {
            latestExtensions.runtime.invalidate("Pi agent child session creation failed");
          }
        }
        throw error;
      }
    },
    {
      cwd: request.cwd,
      agentDir: plan.agentDir,
      sessionManager: SessionManager.inMemory(request.cwd),
      sessionStartEvent: { type: "session_start", reason: "startup" },
    },
  );
  let extensionFailure = false;
  let unsubscribeExtensionErrors: (() => void) | undefined;
  try {
    const session = runtime.session;
    unsubscribeExtensionErrors = session.extensionRunner.onError(() => {
      extensionFailure = true;
    });
    await session.bindExtensions({ mode: "print" });
    assertExactSession(request, session, plan.dispatch);
    const auth = await runtime.services.modelRuntime.getAuth(session.model!, { signal });
    if (auth === undefined) {
      throw new PiAgentGroupError(
        request.id,
        "has no provider authentication",
        plan.dispatch.provider,
      );
    }
    const activeTools = session.getActiveToolNames().toSorted();
    const requestedTools = request.tools.toSorted();
    if (activeTools.join("\0") !== requestedTools.join("\0")) {
      throw new PiAgentGroupError(
        request.id,
        "has unexpected tools",
        activeTools.length === 0 ? "no tools are active" : activeTools.join(", "),
      );
    }
    const toolInfo = new Map(session.getAllTools().map((tool) => [tool.name, tool]));
    for (const tool of requestedTools) {
      if (toolInfo.get(tool)?.sourceInfo.source !== "builtin") {
        throw new PiAgentGroupError(request.id, "has replaced built-in tool", tool);
      }
    }
    let disposed = false;
    return {
      prompt: async (text, promptOptions) =>
        await session.prompt(text, {
          ...promptOptions,
          expandPromptTemplates: false,
          source: "interactive",
        }),
      subscribe: (listener) =>
        session.subscribe((event) => listener(event as unknown as PiAgentEvent)),
      abort: async () => await session.abort(),
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        let disposalFailure: unknown;
        try {
          await runtime.dispose();
        } catch (error) {
          disposalFailure = error;
        } finally {
          unsubscribeExtensionErrors?.();
        }
        if (disposalFailure !== undefined) throw disposalFailure;
        if (extensionFailure) {
          throw new PiAgentGroupError(
            request.id,
            "could not settle child extensions",
            "cleanup failed",
          );
        }
      },
      get model() {
        return session.model;
      },
      get thinkingLevel() {
        return session.thinkingLevel;
      },
    };
  } catch (error) {
    await runtime.dispose().catch(() => undefined);
    unsubscribeExtensionErrors?.();
    throw error;
  }
}

function assertProviderRegistration(
  id: string,
  services: Awaited<ReturnType<typeof createAgentSessionServices>>,
  plan: SdkGroupPlan,
): void {
  if (services.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
    throw new PiAgentGroupError(id, "could not register provider extension", "registration failed");
  }
  if (
    plan.providerExtension &&
    !services.modelRuntime.getRegisteredProviderIds().includes(plan.dispatch.provider)
  ) {
    throw new PiAgentGroupError(
      id,
      "could not register provider extension",
      plan.dispatch.provider,
    );
  }
}

/**
 * The exact dispatch model from the child's model runtime, which resolves it the way Pi does:
 * Pi's bundled catalog, the cached catalog snapshot, `models.json`, and the admitted provider
 * extension. Only a physical chat model qualifies, so a virtual model cannot route the session
 * to another model.
 */
function dispatchModel(id: string, modelRuntime: ModelRuntime, dispatch: PiAgentDispatch) {
  const model = modelRuntime.getPhysicalModel(dispatch.provider, dispatch.modelId);
  if (model === undefined) {
    throw new PiAgentGroupError(id, "has no model", `${dispatch.provider}/${dispatch.modelId}`);
  }
  return model;
}

function assertLoadedProfile(
  id: string,
  result: LoadExtensionsResult,
  extensionPaths: readonly string[],
): void {
  if (result.errors.length > 0) {
    throw new PiAgentGroupError(id, "could not load provider extension", "load failed");
  }
  const loaded = result.extensions
    .map((extension) => path.resolve(extension.resolvedPath))
    .toSorted();
  const expected = extensionPaths.map((extensionPath) => path.resolve(extensionPath)).toSorted();
  if (loaded.join("\0") !== expected.join("\0")) {
    throw new PiAgentGroupError(id, "loaded unexpected extensions", `${loaded.length} loaded`);
  }
  for (const extension of result.extensions) validateAdmittedExtension(extension, "extension");
}

function assertExactSession(
  request: PiAgentRequest,
  session: Awaited<ReturnType<typeof createAgentSession>>["session"],
  dispatch: PiAgentDispatch,
): void {
  if (
    session.model?.provider !== dispatch.provider ||
    session.model.id !== dispatch.modelId ||
    session.thinkingLevel !== dispatch.thinkingLevel
  ) {
    throw new PiAgentGroupError(
      request.id,
      "selected a different model dispatch",
      session.model === undefined
        ? "no model selected"
        : `${session.model.provider}/${session.model.id} ${session.thinkingLevel}`,
    );
  }
}

/**
 * A request that Pi Workflows rejects. The text is Pi Workflows' own and names only request
 * fields, so the message keeps it, unlike the text of a foreign SDK or settings error.
 */
function invalidRequest(text: string): PiAgentGroupError {
  return new PiAgentGroupError("group", "has an invalid request", text);
}

function validatedGroup(
  input: PiAgentRequest[],
  options: PiAgentGroupOptions,
): { requests: PiAgentRequest[]; maxFinalChars: number } {
  try {
    return validateGroup(input, options);
  } catch (error) {
    throw invalidRequest(errorMessage(error));
  }
}

function validateGroup(
  input: PiAgentRequest[],
  options: PiAgentGroupOptions,
): { requests: PiAgentRequest[]; maxFinalChars: number } {
  if (!Array.isArray(input) || input.length > MAX_AGENTS) {
    throw new Error(`Pi agent group must contain at most ${MAX_AGENTS} requests`);
  }
  positiveInteger(options.maxConcurrency, "Pi agent maxConcurrency", MAX_CONCURRENCY);
  const maxFinalChars = options.maxFinalChars ?? DEFAULT_FINAL_CHARS;
  positiveInteger(maxFinalChars, "Pi agent maxFinalChars", MAX_FINAL_CHARS);
  if (
    options.behaviorExtensionPaths !== undefined &&
    (!Array.isArray(options.behaviorExtensionPaths) || options.behaviorExtensionPaths.length > 16)
  ) {
    throw new Error("Pi agent behaviorExtensionPaths must contain at most 16 paths");
  }
  const behaviorPaths = new Set<string>();
  for (const extensionPath of options.behaviorExtensionPaths ?? []) {
    operationalText(extensionPath, "Pi agent behavior extension path", 4_000);
    if (behaviorPaths.has(extensionPath)) {
      throw new Error("Duplicate Pi agent behavior extension path");
    }
    behaviorPaths.add(extensionPath);
  }
  const ids = new Set<string>();
  const requests = input.map((request) => {
    validateRequest(request);
    if (ids.has(request.id)) throw new Error(`Duplicate Pi agent id: ${request.id}`);
    ids.add(request.id);
    return request;
  });
  return { requests, maxFinalChars };
}

function validateRequest(request: PiAgentRequest): void {
  if (!REQUEST_ID.test(request.id)) throw new Error(`Invalid Pi agent id: ${request.id}`);
  operationalText(request.role, "Pi agent role", 200);
  nonEmpty(request.prompt, "Pi agent prompt", PROMPT_CEILING_CHARS);
  if (request.prompt.trimStart().startsWith("/")) {
    throw new Error(`Pi agent ${request.id} prompt must not invoke an extension command`);
  }
  nonEmpty(request.cwd, "Pi agent cwd", 4_000);
  if (!Array.isArray(request.tools) || request.tools.length === 0) {
    throw new Error(`Pi agent ${request.id} requires at least one tool`);
  }
  const tools = new Set<PiAgentTool>();
  for (const tool of request.tools) {
    if (!["read", "grep", "find", "ls"].includes(tool)) {
      throw new Error(`Pi agent ${request.id} has unsupported tool: ${String(tool)}`);
    }
    if (tools.has(tool)) throw new Error(`Pi agent ${request.id} has duplicate tool: ${tool}`);
    tools.add(tool);
  }
  positiveInteger(
    request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    `Pi agent ${request.id} timeoutMs`,
    MAX_TIMEOUT_MS,
  );
  if ((request.model === undefined) !== (request.thinkingLevel === undefined)) {
    throw new Error(`Pi agent ${request.id} must override model and thinkingLevel together`);
  }
  if (request.model !== undefined) {
    operationalText(request.model.provider, `Pi agent ${request.id} model provider`, 200);
    operationalText(request.model.id, `Pi agent ${request.id} model id`, 500);
  }
  if (
    request.thinkingLevel !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(request.thinkingLevel)
  ) {
    throw new Error(`Pi agent ${request.id} has unsupported thinking level`);
  }
}

function eventPhase(event: PiAgentEvent, tools: PiAgentTool[]): string | undefined {
  if (event.type === "message_update" && isRecord(event.assistantMessageEvent)) {
    return event.assistantMessageEvent.type === "thinking_delta" ? "thinking" : undefined;
  }
  if (event.type !== "tool_execution_start" || typeof event.toolName !== "string") return undefined;
  return tools.includes(event.toolName as PiAgentTool) ? `tool: ${event.toolName}` : undefined;
}

function assistantMessage(event: PiAgentEvent): Record<string, unknown> | undefined {
  if (event.type !== "message_end" || !isRecord(event.message)) return undefined;
  return event.message.role === "assistant" ? event.message : undefined;
}

function finalAssistantText(
  id: string,
  message: Record<string, unknown> | undefined,
  maxChars: number,
): string {
  if (message === undefined)
    throw new PiAgentGroupError(id, "returned no final output", "missing assistant message");
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    // The provider's error text can quote the prompt, the response, or credentials.
    const detail = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    throw new PiAgentGroupError(
      id,
      `stopped with ${String(message.stopReason)}`,
      detail === undefined ? "provider stopped" : "the provider reported an error",
      detail === undefined ? {} : { detail },
    );
  }
  const text = messageText(message.content).trim();
  if (!text) throw new PiAgentGroupError(id, "returned no final output", "assistant text is empty");
  if (text.length > maxChars) {
    throw new PiAgentGroupError(id, "final output is too large", `${text.length} characters`);
  }
  return text;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .filter(Boolean)
    .join("\n");
}

async function publishQueuedCancellations(
  requests: PiAgentRequest[],
  started: Set<number>,
  options: PiAgentGroupOptions,
): Promise<void> {
  if (options.onLifecycle === undefined) return;
  await Promise.all(
    requests.map(async (request, index) => {
      if (started.has(index)) return;
      await options.onLifecycle?.({
        id: request.id,
        role: request.role,
        state: "cancelled",
        phase: "cancelled",
        elapsedMs: 0,
      });
    }),
  ).catch(() => undefined);
}

/** A thrown SDK or provider error keeps its text as private detail. */
function normalizeAgentError(
  id: string,
  error: unknown,
  abortKind: "timeout" | "cancelled" | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): PiAgentGroupError {
  if (error instanceof PiAgentGroupError) return error;
  const detail = { detail: errorMessage(error) };
  if (abortKind === "timeout") {
    return new PiAgentGroupError(
      id,
      "timed out",
      `after ${timeoutMs}ms; the session raised an error`,
      detail,
    );
  }
  if (abortKind === "cancelled" || signal.aborted) return cancellationError(id, signal.reason);
  return new PiAgentGroupError(id, "failed", "the session raised an error", detail);
}

function terminalState(error: unknown): PiAgentLifecycleState {
  if (error === undefined) return "completed";
  return error instanceof PiAgentGroupError && error.code === "cancelled" ? "cancelled" : "failed";
}

function cancellationError(id: string, reason: unknown): PiAgentGroupError {
  return new PiAgentGroupError(id, "cancelled", cancellationReason(reason));
}

function cancellationReason(reason: unknown): string {
  return reason === undefined ? "operation cancelled" : errorMessage(reason);
}

/**
 * A session stopped by its timeout or by cancellation. A failed session abort is a fact; the
 * abort's own error text is private detail.
 */
function stoppedError(
  id: string,
  abortKind: "timeout" | "cancelled" | undefined,
  timeoutMs: number,
  signal: AbortSignal,
  abortFailure: unknown,
): PiAgentGroupError {
  const timedOut = abortKind === "timeout";
  const code = timedOut ? "timed out" : "cancelled";
  const facts = timedOut ? `after ${timeoutMs}ms` : cancellationReason(signal.reason);
  if (abortFailure === undefined) return new PiAgentGroupError(id, code, facts);
  return new PiAgentGroupError(id, code, `${facts}; the session abort failed`, {
    detail: errorMessage(abortFailure),
  });
}

function modelName(model: { provider: string; id: string } | undefined): string {
  if (model === undefined) throw new Error("No usable Pi model is configured");
  const value = `${model.provider}/${model.id}`;
  operationalText(value, "Pi model identity", 700);
  return value;
}

function positiveInteger(value: unknown, label: string, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new Error(`${label} must be an integer from 1 through ${max}`);
  }
}

function operationalText(value: unknown, label: string, max: number): asserts value is string {
  nonEmpty(value, label, max);
  if (
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 32 || (code >= 127 && code <= 159);
    })
  ) {
    throw new Error(`${label} must not contain control characters`);
  }
}

function nonEmpty(value: unknown, label: string, max: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    throw new Error(`${label} must be a non-empty string with at most ${max} characters`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
