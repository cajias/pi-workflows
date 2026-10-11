import { describe, expect, it } from "vitest";
import autoimplementWorkflow, {
  type AutoimplementSettings,
} from "../src/builtins/autoimplement.workflow.js";
import type { ActorType } from "../src/state/index.js";
import { compute, defineWorkflow } from "../src/workflows/definition.js";
import { WorkflowEngine } from "../src/workflows/engine.js";
import {
  applyWorkflowSettingsPatch,
  parseWorkflowSettingsValue,
  resolveInitialWorkflowSettings,
} from "../src/workflows/settings.js";
import { WorkflowRunStore } from "../src/workflows/store.js";
import { ScriptedExecutor, makeStateDatabasePath } from "./helpers.js";
import { autoimplementSettingsValue } from "./helpers/autoimplement-fixtures.js";

const definition = autoimplementWorkflow.settings;
if (definition === undefined) throw new Error("autoimplement settings are missing");
const settingsDefinition = definition;

async function patch(
  before: Record<string, unknown>,
  operations: unknown[],
  actor: ActorType,
): Promise<unknown> {
  const applied = await applyWorkflowSettingsPatch(
    settingsDefinition,
    autoimplementSettingsValue(before),
    operations,
    { type: actor },
    "workflow-tool",
  );
  return applied.settings;
}

describe("autoimplement settings", () => {
  it("carries the requested forge and timing from the parsed input", async () => {
    const parseInput = autoimplementWorkflow.input;
    if (parseInput === undefined) throw new Error("autoimplement input parser is missing");
    const input = await parseInput({
      task: "demo",
      repository: "/repo",
      forge: "gitlab",
      prTiming: "end",
      merge: true,
    });
    await expect(resolveInitialWorkflowSettings(settingsDefinition, input)).resolves.toMatchObject({
      settings: { merge: true, addedInstructions: [], forge: "gitlab", prTiming: "end" },
    });
    await expect(
      resolveInitialWorkflowSettings(settingsDefinition, { task: "demo", repository: "/repo" }),
    ).resolves.toMatchObject({
      settings: { merge: false, addedInstructions: [], forge: "auto", prTiming: "early" },
    });
    expect(settingsDefinition.description).toBe(
      "Future merge behavior, publication timing, the requested forge, and instructions added during this run.",
    );
  });

  it.each(["session", "human", "resource_manager"] as const)(
    "does not let %s replace the requested forge",
    async (actor) => {
      await expect(
        patch({}, [{ op: "replace", path: "/forge", value: "gitlab" }], actor),
      ).rejects.toThrow(`Workflow settings replace is not allowed at "/forge" for actor ${actor}`);
    },
  );

  it("rejects a forge change even when a path rule would allow it", async () => {
    const validate = settingsDefinition.validateChange;
    if (validate === undefined) throw new Error("autoimplement settings validateChange is missing");
    expect(() =>
      validate({
        before: autoimplementSettingsValue({ forge: "auto" }) as AutoimplementSettings,
        after: autoimplementSettingsValue({ forge: "gitlab" }) as AutoimplementSettings,
        actor: { type: "human" },
        source: "interactive-command",
        patch: [],
      }),
    ).toThrow("The requested forge cannot change during a run");
  });

  it("lets only a human move publication timing from end to early", async () => {
    const toEarly = [{ op: "replace", path: "/prTiming", value: "early" }];
    await expect(patch({ prTiming: "end" }, toEarly, "human")).resolves.toMatchObject({
      prTiming: "early",
    });
    for (const actor of ["session", "resource_manager"] as const) {
      await expect(patch({ prTiming: "end" }, toEarly, actor)).rejects.toThrow(
        `Workflow settings replace is not allowed at "/prTiming" for actor ${actor}`,
      );
    }
    await expect(
      patch({ prTiming: "early" }, [{ op: "replace", path: "/prTiming", value: "end" }], "human"),
    ).rejects.toThrow("Publication timing cannot move from early to end during a run");
    await expect(
      patch({ prTiming: "end" }, [{ op: "replace", path: "/prTiming", value: "end" }], "human"),
    ).resolves.toMatchObject({ prTiming: "end" });
    await expect(
      patch({ prTiming: "end" }, [{ op: "replace", path: "/prTiming", value: "late" }], "human"),
    ).rejects.toThrow("autoimplement settings prTiming must be early or end");
  });

  it("requires both new fields in a settings value", async () => {
    const { forge: _forge, ...withoutForge } = autoimplementSettingsValue();
    const { prTiming: _prTiming, ...withoutTiming } = autoimplementSettingsValue();
    await expect(parseWorkflowSettingsValue(settingsDefinition, withoutForge)).rejects.toThrow(
      "autoimplement settings forge is required",
    );
    await expect(parseWorkflowSettingsValue(settingsDefinition, withoutTiming)).rejects.toThrow(
      "autoimplement settings prTiming is required",
    );
    await expect(
      parseWorkflowSettingsValue(
        settingsDefinition,
        autoimplementSettingsValue({ forge: "gitea" }),
      ),
    ).rejects.toThrow("autoimplement settings forge must be auto, github, or gitlab");
  });

  it("keeps the merge rules", async () => {
    await expect(
      patch({ merge: true }, [{ op: "replace", path: "/merge", value: false }], "session"),
    ).resolves.toMatchObject({ merge: false });
    await expect(
      patch({ merge: false }, [{ op: "replace", path: "/merge", value: true }], "session"),
    ).rejects.toThrow("A model workflow step cannot grant merge authority");
    await expect(
      patch({ merge: false }, [{ op: "replace", path: "/merge", value: true }], "human"),
    ).resolves.toMatchObject({ merge: true });
    await expect(
      patch({}, [{ op: "add", path: "/addedInstructions/-", value: "Keep it small." }], "session"),
    ).resolves.toMatchObject({ addedInstructions: ["Keep it small."] });
  });

  it("applies a human end-to-early change through the run store during a run", async () => {
    const databasePath = await makeStateDatabasePath("autoimplement-settings-store");
    const externalStore = new WorkflowRunStore(databasePath);
    const outcomes: string[] = [];
    const workflow = defineWorkflow({
      name: "autoimplement-settings-store",
      settings: settingsDefinition,
      startAt: "change",
      nodes: {
        change: compute({
          run: async ({ state, settingsScopeId, settings }) => {
            const request = (requestId: string, type: ActorType, value: string) => ({
              runId: state.runId,
              scopeId: settingsScopeId as string,
              requestId,
              actor: { type },
              source: type === "human" ? "interactive-command" : "workflow-tool",
              patch: [{ op: "replace", path: "/prTiming", value }],
            });
            for (const [requestId, type, value] of [
              ["session-to-early", "session", "early"],
              ["human-to-early", "human", "early"],
              ["human-to-end", "human", "end"],
            ] as const) {
              try {
                await externalStore.changeSettings(
                  settingsDefinition,
                  request(requestId, type, value),
                );
                outcomes.push(`${requestId}: accepted`);
              } catch (error) {
                outcomes.push(`${requestId}: ${(error as Error).message}`);
              }
            }
            return { started: settings };
          },
        }),
        read: compute({ run: ({ settings }) => ({ settings }) }),
      },
      edges: [{ from: "change", to: "read" }],
    });
    const { state } = await new WorkflowEngine({
      databasePath,
      executor: new ScriptedExecutor(),
    }).run(workflow, { task: "demo", repository: "/repo", prTiming: "end" });
    externalStore.close();

    expect(state.status, state.error).toBe("completed");
    expect(state.outputs.change).toMatchObject({ started: { prTiming: "end" } });
    expect(state.finalOutput).toMatchObject({
      settings: { prTiming: "early", forge: "auto", merge: false },
    });
    expect(outcomes[0]).toContain('replace is not allowed at "/prTiming" for actor session');
    expect(outcomes[1]).toBe("human-to-early: accepted");
    expect(outcomes[2]).toContain("Publication timing cannot move from early to end during a run");
  });
});
