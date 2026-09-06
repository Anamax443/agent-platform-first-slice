// Workflow definitions are data (workflows/*.json), bundled and checked fail-closed before an orchestrator exists.
import documentIntakeJson from "../../workflows/document-intake.v1.json" with { type: "json" };
import mailIntakeJson from "../../workflows/mail-intake.v1.json" with { type: "json" };
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

/** Every workflow definition this platform can run, validated fail-closed at import. Same list under Node and in a Worker. */
export const WORKFLOW_DEFINITIONS: Readonly<Record<string, WorkflowDef>> = Object.freeze(
  Object.fromEntries([documentIntakeJson, mailIntakeJson].map(parseWorkflowDef).map((d) => [d.workflow, d])),
);

export function workflowDef(name: string): WorkflowDef {
  const def = WORKFLOW_DEFINITIONS[name];
  if (!def) throw new Error(`unknown workflow definition ${name}`);
  return def;
}
