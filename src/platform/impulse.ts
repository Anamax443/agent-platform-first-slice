// docs/AUTONOMOUS-RUNTIME-V1.md część 5 — the `normalize(channel-specific) → NormalizedImpulse` step of the
// new `/impulse` ingress contract. Pure, channel-agnostic (case.ts's own hard invariant: an ingress adapter
// normalizes SHAPE only, never decides workflow/goal/intent) and, same discipline as case-projection.ts, no
// I/O and no clock read inside the function itself — impulseId/receivedAt are minted by the caller, exactly
// like newCase()'s own caseId.
import type { ArtifactRef, NormalizedImpulse } from "./case.js";

export class ImpulseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImpulseError";
  }
}

export interface ImpulseInput {
  readonly channel: string;
  readonly tenantId: string;
  readonly impulseId: string;
  readonly receivedAt: string;
  readonly sender?: string;
  readonly text?: string;
  /** ArtifactRef ids the caller already holds (some other path already turned bytes into an Artifact) — this
   *  function never touches bytes, extraction, R2 or AI. A channel that only has raw bytes today (an upload,
   *  a binary attachment) turns them into an Artifact BEFORE calling normalizeImpulse(), the same way mail's
   *  own createCaseForMailIntake() already does with mail.ingest's output. Conscious simplification, not a
   *  gap (same shape as case-projection.ts's pendingCapabilities): per-channel extraction is channel-specific
   *  work part 5 explicitly defers, not something this shared normalizer should special-case. */
  readonly attachments?: readonly string[];
  readonly thread?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

/**
 * ADR część 5: `POST /impulse {channel, content, attachments?, metadata?} → normalize → NormalizedImpulse`.
 * Fails closed on an impulse that would carry nothing at all (no text, no attachments) — same "reject, never
 * silently accept a no-op" discipline the rest of this platform holds elsewhere (e.g. startIntake()'s own
 * EMPTY_TEXT check) — callers surface ImpulseError as a 400, never a Case with an empty impulse.
 */
export function normalizeImpulse(input: ImpulseInput): NormalizedImpulse {
  if (!input.channel.trim()) throw new ImpulseError("channel must not be empty");
  const text = input.text?.trim() ? input.text : undefined;
  const artifacts: ArtifactRef[] = (input.attachments ?? []).map((artifactId) => ({ artifactId }));
  if (!text && artifacts.length === 0) throw new ImpulseError("impulse must carry at least text or one attachment");
  return {
    impulseId: input.impulseId,
    tenantId: input.tenantId,
    channel: input.channel,
    ...(input.sender ? { sender: input.sender } : {}),
    receivedAt: input.receivedAt,
    ...(text ? { text } : {}),
    artifacts,
    ...(input.thread ? { thread: input.thread } : {}),
    metadata: input.metadata ?? {},
  };
}
