// Workflow definitions are data (workflows/*.json), bundled and checked fail-closed before an orchestrator exists.
import documentIntakeV1 from "../../workflows/document-intake.v1.json" with { type: "json" };
import documentIntakeV2 from "../../workflows/document-intake.v2.json" with { type: "json" };
import mailIntakeV1 from "../../workflows/mail-intake.v1.json" with { type: "json" };
import mailIntakeV2 from "../../workflows/mail-intake.v2.json" with { type: "json" };
import workflowSchema from "../../workflows/workflow-definition.schema.json" with { type: "json" };
import type { WorkflowDef } from "./orchestrator.js";
import { compileSchema } from "./schemas.js";

const validate = compileSchema(workflowSchema);

/** Schema, unique step ids, every `$steps.<id>` ref points to an earlier step. Anything else throws. */
export function parseWorkflowDef(json: unknown): WorkflowDef {
  const v = validate(json);
  if (!v.ok) throw new Error(`workflow definition invalid (fail-closed): ${v.errors}`);
  const def = json as WorkflowDef;
  const where = `workflow ${def.workflow}/v${def.workflowVersion}`;
  const earlier = new Set<string>();
  for (const step of def.steps) {
    if (earlier.has(step.id)) throw new Error(`${where}: duplicate step id ${step.id}`);
    for (const ref of stepRefs(step.inputs)) {
      if (!earlier.has(ref)) throw new Error(`${where}: step ${step.id} refers to $steps.${ref}, which is not an earlier step`);
    }
    earlier.add(step.id);
  }
  return def;
}

function* stepRefs(value: unknown): Generator<string> {
  if (typeof value === "string") {
    if (value.startsWith("$steps.")) yield value.slice(7).split(".")[0] as string;
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const v of Object.values(value)) yield* stepRefs(v);
  }
}

/**
 * Every workflow definition this platform can run, validated fail-closed at import; same list under Node and in a Worker.
 * Keyed twice: `<name>@<version>` for every version (running instances pin theirs, WF-VER-001) and `<name>` for the latest.
 */
export const WORKFLOW_DEFINITIONS: Readonly<Record<string, WorkflowDef>> = (() => {
  const all = [documentIntakeV1, documentIntakeV2, mailIntakeV1, mailIntakeV2].map(parseWorkflowDef);
  const out: Record<string, WorkflowDef> = {};
  for (const d of all) {
    const key = `${d.workflow}@${d.workflowVersion}`;
    if (out[key]) throw new Error(`workflow ${key} defined twice`);
    out[key] = d;
    const latest = out[d.workflow];
    if (!latest || Number(d.workflowVersion) > Number(latest.workflowVersion)) out[d.workflow] = d;
  }
  return Object.freeze(out);
})();

/** The latest version of a workflow, or one pinned version. Unknown = exception (never a guessed default). */
export function workflowDef(name: string, version?: string): WorkflowDef {
  const def = WORKFLOW_DEFINITIONS[version ? `${name}@${version}` : name];
  if (!def) throw new Error(`unknown workflow definition ${name}${version ? `@${version}` : ""}`);
  return def;
}

/** Names of the workflows (without versions), for lists shown to an operator. */
export const WORKFLOW_NAMES: readonly string[] = Object.freeze([...new Set(Object.values(WORKFLOW_DEFINITIONS).map((d) => d.workflow))]);
