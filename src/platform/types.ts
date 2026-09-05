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

/** What a handler returns before the router wraps it into a ResultEnvelope. */
export type HandlerOutcome =
  | { status: "SUCCEEDED"; payload: Record<string, unknown>; provenance?: Provenance }
  | { status: "FAILED"; error: ErrorObject }
  | { status: "WAITING"; waitReason: WaitReason; deadline: string; reviewTaskId?: string; payload?: Record<string, unknown> }
  | { status: "UNKNOWN_OUTCOME"; reconciliationRef: string };

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
