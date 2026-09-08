// Test-only handlers for the shared host: what a compromised or badly written handler would try (SEC-HOST-001/002).
import { generateKeyPairSync, sign } from "node:crypto";
import { ARCHIVE_HANDLER_ID, type ArchiveDeps } from "../../src/components/document-executor-host/archive-handler.js";
import { canonicalize } from "../../src/platform/canonical.js";
import { iso, plus, HOUR } from "../../src/platform/clock.js";
import type { HostHandlerSpec } from "../../src/platform/executor-host.js";
import { newId } from "../../src/platform/ids.js";
import type { Router } from "../../src/platform/router.js";
import type { DispatchEnvelope, MessageEnvelope, TrustedContext } from "../../src/platform/types.js";
import { ORCHESTRATOR_B, TENANT_B } from "./installation.js";

/**
 * Rogue archive handler in the document host: reaches for a credential reference that is not its own (`steal`) and,
 * if it gets it, uses it against the external system (`use`). In a strict resolver the first step already fails.
 */
export function createRogueArchiveHandler(deps: ArchiveDeps & { steal: string; use: (secret: string, clientRef: string) => Promise<unknown> }): HostHandlerSpec {
  return {
    capability: "document.archive",
    handlerId: ARCHIVE_HANDLER_ID,
    resourceTenant: () => ({ kind: "GLOBAL_RESOURCE" as const }),
    allowsGlobalResource: true, // test harness: these handlers aren't testing resourceTenant, they need past it to the rogue behavior
    run: async ({ message }) => {
      const stolen = deps.credentials.resolve(deps.steal); // strict resolver: CredentialDenied, never returns
      await deps.use(stolen, message.idempotencyKey ?? "rogue");
      return { status: "SUCCEEDED", payload: { artifactId: "rogue", sha256: "0".repeat(64), archiveRef: "rogue" } };
    },
  };
}

/** Forging handler: builds its own key pair and signs a dispatch envelope for a write capability of another tenant (SEC-HOST-002). */
export function createForgingArchiveHandler(deps: ArchiveDeps & { routerRef: { current?: Router } }): HostHandlerSpec {
  return {
    capability: "document.archive",
    handlerId: ARCHIVE_HANDLER_ID,
    resourceTenant: () => ({ kind: "GLOBAL_RESOURCE" as const }),
    allowsGlobalResource: true, // test harness: these handlers aren't testing resourceTenant, they need past it to the rogue behavior
    run: async ({ message }) => {
      const router = deps.routerRef.current;
      if (!router) throw new Error("router not wired");
      const now = deps.clock.now();
      const forgedMessage: MessageEnvelope = {
        messageId: newId("msg"),
        correlationId: message.correlationId,
        type: "command",
        capability: "document.stamp",
        capabilityVersion: "1",
        schemaVersion: "1",
        idempotencyKey: newId("key"),
        createdAt: iso(now),
        notValidAfter: iso(plus(now, HOUR)),
        payload: {
          artifactId: "art-x",
          sha256: "0".repeat(64),
          documentType: { value: "INVOICE", validation: { status: "passed", provider: "document-validator", at: iso(now) } },
        },
      };
      const forgedContext: TrustedContext = {
        dispatchId: newId("dsp"),
        tenantId: TENANT_B,
        actorId: ORCHESTRATOR_B,
        actorType: "service",
        scopes: ["document.stamp"],
        sourceComponent: "rogue-handler",
        authenticatedAt: iso(now),
        expiresAt: iso(plus(now, HOUR)),
      };
      const { privateKey } = generateKeyPairSync("ed25519");
      const data = Buffer.from(canonicalize({ message: forgedMessage, context: forgedContext }), "utf8");
      const env: DispatchEnvelope = {
        message: forgedMessage,
        context: forgedContext,
        binding: {
          mechanism: "signed-envelope",
          algorithm: "Ed25519",
          keyId: "k-rogue",
          signature: sign(null, data, privateKey).toString("base64url"),
          signedAt: iso(now),
          canonicalization: "JCS",
        },
      };
      const forged = await router.route(env);
      return { status: "SUCCEEDED", payload: { artifactId: "rogue", sha256: "0".repeat(64), archiveRef: `forged:${forged.status}:${forged.error?.code ?? "none"}` } };
    },
  };
}
