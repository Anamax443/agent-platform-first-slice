// Types mirror contracts/*.v1.schema.json (agent-platform-foundation 1.0-rc2.1). Schemas are the authority.

export type MessageType = "command" | "event" | "query";

export interface MessageEnvelope {
  messageId: string;
  correlationId: string;
  causationId?: string;
  workflowId?: string;
  stepId?: string;
  type: MessageType;
  capability: string;
  capabilityVersion: string;
  schemaVersion: string;
  idempotencyKey?: string;
  createdAt: string;
  notValidAfter?: string;
  payload: Record<string, unknown>;
}

export type ActorType =
  | "human"
  | "ai-agent"
  | "deterministic-module"
  | "executor"
  | "endpoint-agent"
  | "service"
  | "scheduler";

export type AuthStrength = "oidc-user" | "client-credentials" | "certificate" | "session" | "mtls";

export interface TrustedContext {
  dispatchId: string;
  tenantId: string;
  actorId: string;
  actorType: ActorType;
  originatingActorId?: string;
  authStrength?: AuthStrength;
  scopes: string[];
  sourceComponent: string;
  targetComponent?: string;
  authenticatedAt: string;
  expiresAt: string;
}

export interface Binding {
  mechanism: "in-process" | "signed-envelope" | "broker-identity" | "token-bound" | "mtls";
  algorithm?: "HMAC-SHA256" | "Ed25519";
  keyId?: string;
  signature?: string;
  signedAt?: string;
  canonicalization?: "JCS";
}

export interface DispatchEnvelope {
  message: MessageEnvelope;
  context: TrustedContext;
  binding: Binding;
}

export type ErrorClass =
  | "TECHNICAL"
  | "QUALITY"
  | "BUSINESS"
  | "SECURITY"
  | "POLICY"
  | "VALIDATION"
  | "DEPENDENCY"
  | "UNKNOWN";

export interface ErrorObject {
  code: string;
  class: ErrorClass;
  retryable: boolean;
  reissuable?: boolean;
  message: string;
  details?: Record<string, unknown>;
  retryAfter?: string;
  diagnosticRef?: string;
}

export type ResultStatus = "SUCCEEDED" | "FAILED" | "WAITING" | "UNKNOWN_OUTCOME" | "CANCELLED";
export type WaitReason = "EXTERNAL" | "REVIEW" | "SCHEDULE" | "DEPENDENCY";

export interface Provenance {
  producerComponent?: string;
  producerVersion?: string;
  modelId?: string;
  promptVersion?: string;
  derivedFrom?: string[];
}

export interface ResultEnvelope {
  messageId: string;
  inReplyTo: string;
  correlationId: string;
  workflowId?: string;
  stepId?: string;
  executionId?: string;
  status: ResultStatus;
  capability: string;
  capabilityVersion: string;
  schemaVersion: string;
  completedAt: string;
  payload?: Record<string, unknown>;
  error?: ErrorObject;
  waitReason?: WaitReason;
  deadline?: string;
  reviewTaskId?: string;
  reconciliationRef?: string;
  provenance?: Provenance;
}

/** Token counts a real model call actually consumed, carried on HandlerOutcome for the router's "model-usage"
 * audit record — not part of any frozen contract (ResultEnvelope never carries it). Structurally identical to,
 * but independently declared from, adapters/llm.ts's TokenUsage: ARCH-DEP-001 forbids platform/* importing from
 * adapters/*, so each layer owns its own copy of the shape rather than sharing a type import across that
 * boundary (adapters may import only platform/errors.js the other way, never platform/types.js). */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** What a handler returns before the router wraps it into a ResultEnvelope. `modelUsage` and `provenance` are
 * additive on every variant: a handler that never calls an LlmAdapter never sets them, and the router only acts
 * on them when present. `provenance` used to live only on SUCCEEDED, which meant a FAILED result (e.g. a model
 * call that answered but with disallowed output, QUALITY/MODEL_OUTPUT_NOT_ALLOWED) could never say which model
 * ran — even though the handler knows modelId at that point. Owner's request 17.9.2026: the model used should be
 * visible on every step, failed ones included. */
export type HandlerOutcome = (
  | { status: "SUCCEEDED"; payload: Record<string, unknown> }
  | { status: "FAILED"; error: ErrorObject }
  | { status: "WAITING"; waitReason: WaitReason; deadline: string; reviewTaskId?: string; payload?: Record<string, unknown> }
  | { status: "UNKNOWN_OUTCOME"; reconciliationRef: string }
) & { modelUsage?: TokenUsage; provenance?: Provenance };

export interface HandlerInput {
  message: MessageEnvelope;
  context: TrustedContext;
}

export type Handler = (input: HandlerInput) => Promise<HandlerOutcome>;

/** Field-level provenance carried inside payloads (FOUNDATION-core §7). */
export interface FieldValue<T = unknown> {
  value: T;
  source?: "llm" | "ocr" | "rules" | "registry" | "human";
  confidence?: number;
  trustLevel?: "untrusted-derived" | "validated" | "human-corrected";
  validation?: { status: "passed" | "failed"; provider: string; at: string };
}
