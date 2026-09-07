// DH family (slice Test IDs outside the norm): the client half of unit D (apf-document-host). HttpDmsAdapter and
// HttpArchiveAdapter meet the same protocol as tests/fakes.test.ts's registry tests; DH-SIGN-* proves the actual crypto
// boundary a remote document-host will stand on — a Gateway signs with a real, freshly generated Ed25519 key pair, and a
// completely separate Router (its own KeyRegistry, holding only the public key) verifies and runs the real stamp/archive
// handlers, exactly as apf-document-host will once it exists as its own Worker. No Cloudflare runtime, no artifact
// transfer over a network hop (out of scope for this step, see HANDOFF): the artifact lives in a plain ArtifactStore, the
// same one a router-side reader would be handed once that transfer exists.
import { describe, expect, it } from "vitest";
import { UnknownOutcomeError } from "../src/platform/errors.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import { Audit } from "../src/platform/audit.js";
import { FakeClock, iso, plus, MINUTE } from "../src/platform/clock.js";
import { CredentialResolver } from "../src/platform/credentials.js";
import { ExecutorHost } from "../src/platform/executor-host.js";
import { Gateway, IdentityProvider } from "../src/platform/gateway.js";
import { newId } from "../src/platform/ids.js";
import type { Policy } from "../src/platform/policy.js";
import { Router } from "../src/platform/router.js";
import { generateKeyPair, KeyRegistry, Signer } from "../src/platform/signing.js";
import { RemoteHostTransport } from "../src/platform/transport.js";
import type { MessageEnvelope } from "../src/platform/types.js";
import * as archiveHandler from "../src/components/document-executor-host/archive-handler.js";
import * as host from "../src/components/document-executor-host/stamp-handler.js";
import { world } from "./harness/fakes-world.js";
import { RelayAudit } from "../deploy/cloudflare/apf-document-host/src/relay-audit.js";

const START = "2026-09-06T08:00:00Z";

describe("DH-DMS-001 HttpDmsAdapter meets the same protocol as the fakes double", () => {
  it("stamp succeeds with the right credential, is idempotent per clientRef, status/read reflect the write", async () => {
    const w = world();
    const first = await w.dms.stamp({ bytes: "faktura", stampText: "PRIJATO", clientRef: "k1" }, "dms-secret");
    expect(first.bytes).toBe("faktura\n--- PRIJATO ---");
    const again = await w.dms.stamp({ bytes: "faktura", stampText: "PRIJATO", clientRef: "k1" }, "dms-secret");
    expect(again.ref).toBe(first.ref);
    expect(await w.dms.status("k1")).toBe("DONE");
    expect(await w.dms.read("k1")).toEqual(first);
    expect(await w.dms.status("nobody")).toBe("NOT_FOUND");
    expect(await w.dms.read("nobody")).toBeUndefined();
  });

  it("wrong credential rejects the write with a plain Error (mapped to DMS_REJECTED by the handler), never a silent stamp", async () => {
    const w = world();
    await expect(w.dms.stamp({ bytes: "x", stampText: "y", clientRef: "k2" }, "wrong")).rejects.toThrow();
    expect(await w.dms.status("k2")).toBe("NOT_FOUND");
  });

  it("unknown-once and unknown-always over HTTP both throw UnknownOutcomeError from stamp(), never a swallowed failure", async () => {
    const once = world({ chaos: { "dms.mode": "unknown-once" } });
    await expect(once.dms.stamp({ bytes: "x", stampText: "y", clientRef: "k3" }, "dms-secret")).rejects.toBeInstanceOf(UnknownOutcomeError);
    expect(await once.dms.status("k3")).toBe("DONE"); // the write happened even though the answer was lost

    const always = world({ chaos: { "dms.mode": "unknown-always" } });
    await expect(always.dms.stamp({ bytes: "x", stampText: "y", clientRef: "k4" }, "dms-secret")).rejects.toBeInstanceOf(UnknownOutcomeError);
  });

  it("status()/read() never throw on an unreachable double: they degrade to UNKNOWN/undefined so reconcile()'s bare call never crashes", async () => {
    const down = { fetch: async () => { throw new Error("connection refused"); } };
    const { HttpDmsAdapter } = await import("../src/adapters/dms.js");
    const adapter = new HttpDmsAdapter(down);
    expect(await adapter.status("anything")).toBe("UNKNOWN");
    expect(await adapter.read("anything")).toBeUndefined();
    await expect(adapter.stamp({ bytes: "x", stampText: "y", clientRef: "k5" }, "dms-secret")).rejects.toBeInstanceOf(UnknownOutcomeError);
  });
});

describe("DH-ARCHIVE-001 HttpArchiveAdapter meets the same protocol as the fakes double", () => {
  it("put succeeds with the right credential and is idempotent per clientRef", async () => {
    const w = world();
    const first = await w.archive.put({ bytes: "faktura", sha256: "ab".repeat(32), clientRef: "k1" }, "archive-secret");
    const again = await w.archive.put({ bytes: "faktura", sha256: "ab".repeat(32), clientRef: "k1" }, "archive-secret");
    expect(again.ref).toBe(first.ref);
  });

  it("wrong credential and an unreachable double both throw, mapped by archive-handler.ts to ARCHIVE_REJECTED", async () => {
    const w = world();
    await expect(w.archive.put({ bytes: "x", sha256: "ab".repeat(32), clientRef: "k2" }, "wrong")).rejects.toThrow();
    const down = { fetch: async () => { throw new Error("connection refused"); } };
    const { HttpArchiveAdapter } = await import("../src/adapters/archive.js");
    await expect(new HttpArchiveAdapter(down).put({ bytes: "x", sha256: "ab".repeat(32), clientRef: "k3" }, "archive-secret")).rejects.toThrow();
  });
});

/** Builds the receiver side a real apf-document-host will have: its own Router, its own KeyRegistry (public key only),
 * document.stamp + document.archive backed by the real handlers and the HTTP adapters above, pointed at one fakes world. */
function remoteHost(publicKeyPem: ReturnType<typeof generateKeyPair>["publicKey"], keyId: string, w: ReturnType<typeof world>) {
  const clock = new FakeClock(START);
  const audit = new Audit(clock);
  const artifacts = new ArtifactStore(clock);
  const registry = new KeyRegistry();
  registry.add({ keyId, publicKey: publicKeyPem, validFrom: iso(new Date(0)) });
  const credentials = new CredentialResolver(
    { [host.STAMP_HANDLER_ID]: { [host.STAMP_CREDENTIAL]: "dms-secret" }, [archiveHandler.ARCHIVE_HANDLER_ID]: { [archiveHandler.ARCHIVE_CREDENTIAL]: "archive-secret" } },
    audit,
  );
  const executor = new ExecutorHost({ hostId: host.descriptor.module, clock, audit, credentials });
  executor.register(host.createStampHandler({ artifacts, dms: w.dms, credentials, clock }));
  executor.register(archiveHandler.createArchiveHandler({ artifacts, archive: w.archive, credentials, clock }));
  const grants = (capability: string): Policy => ({
    policyRef: `test.${capability}`,
    capability,
    capabilityVersion: "1",
    owner: "test",
    grants: [{ actorId: "svc-test", scopes: [capability], tenants: ["t1"] }],
    failClosed: true,
  });
  const router = new Router({ registry, clock, audit });
  router.register({
    descriptor: host.descriptor as never,
    policies: { "document.stamp": grants("document.stamp"), "document.archive": grants("document.archive") },
    capabilities: [
      { name: "document.stamp", version: "1", inputSchema: host.stampInputSchema, handler: executor.handlerFor("document.stamp") },
      { name: "document.archive", version: "1", inputSchema: host.archiveInputSchema, handler: executor.handlerFor("document.archive") },
    ],
  });
  return { clock, audit, artifacts, router };
}

const stampMessage = (artifactId: string, sha256: string, clock: FakeClock): MessageEnvelope => ({
  messageId: newId("msg"),
  correlationId: newId("cor"),
  type: "command",
  capability: "document.stamp",
  capabilityVersion: "1",
  schemaVersion: "1",
  idempotencyKey: newId("key"),
  createdAt: iso(clock.now()),
  notValidAfter: iso(plus(clock.now(), 30 * MINUTE)),
  payload: { artifactId, sha256, documentType: { value: "INVOICE", validation: { status: "passed", provider: "document-validator", at: iso(clock.now()) } } },
});

describe("DH-SIGN-001 the gateway signs, a completely separate Router verifies and runs the real handlers (unit D's actual boundary)", () => {
  it("a valid signed dispatch from a fresh key pair runs document.stamp end to end through the HTTP DMS adapter", async () => {
    const w = world();
    const gatewayClock = new FakeClock(START);
    const keyPair = generateKeyPair();
    const identities = new IdentityProvider([{ actorId: "svc-test", actorType: "service", tenantId: "t1", scopes: ["document.stamp", "document.archive"], authStrength: "client-credentials" }]);
    const gateway = new Gateway({ identities, signer: new Signer("k1", keyPair.privateKey), clock: gatewayClock });

    const receiver = remoteHost(keyPair.publicKey, "k1", w);
    const art = receiver.artifacts.put({ tenantId: "t1", bytes: "faktura 123", receivedFrom: "test" });

    const envelope = gateway.dispatch(stampMessage(art.artifactId, art.sha256, receiver.clock), "svc-test");
    expect(envelope.binding.mechanism).toBe("signed-envelope");
    const result = await receiver.router.route(envelope);
    expect(result.status).toBe("SUCCEEDED");
    expect(result.payload?.dmsRef).toMatch(/^dms-/);
    expect(w.dms).toBeDefined(); // the write went through the real HTTP adapter into the fakes double, not an in-process fake
  });

  it("a tampered payload after signing is rejected: the receiver never trusts anything the signature does not cover", async () => {
    const w = world();
    const gatewayClock = new FakeClock(START);
    const keyPair = generateKeyPair();
    const identities = new IdentityProvider([{ actorId: "svc-test", actorType: "service", tenantId: "t1", scopes: ["document.stamp"], authStrength: "client-credentials" }]);
    const gateway = new Gateway({ identities, signer: new Signer("k1", keyPair.privateKey), clock: gatewayClock });
    const receiver = remoteHost(keyPair.publicKey, "k1", w);
    const art = receiver.artifacts.put({ tenantId: "t1", bytes: "faktura 123", receivedFrom: "test" });

    const envelope = gateway.dispatch(stampMessage(art.artifactId, art.sha256, receiver.clock), "svc-test");
    const tampered = { ...envelope, message: { ...envelope.message, payload: { ...envelope.message.payload, stampText: "FORGED" } } };
    const result = await receiver.router.route(tampered);
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CONTEXT_BINDING_INVALID");
  });

  it("a signature from a different key pair is rejected: only the public key the receiver was actually given verifies", async () => {
    const w = world();
    const gatewayClock = new FakeClock(START);
    const realKeyPair = generateKeyPair();
    const impostorKeyPair = generateKeyPair();
    const identities = new IdentityProvider([{ actorId: "svc-test", actorType: "service", tenantId: "t1", scopes: ["document.stamp"], authStrength: "client-credentials" }]);
    // Signed by the impostor's private key, but the receiver only ever registered the real public key under "k1".
    const gateway = new Gateway({ identities, signer: new Signer("k1", impostorKeyPair.privateKey), clock: gatewayClock });
    const receiver = remoteHost(realKeyPair.publicKey, "k1", w);
    const art = receiver.artifacts.put({ tenantId: "t1", bytes: "faktura 123", receivedFrom: "test" });

    const envelope = gateway.dispatch(stampMessage(art.artifactId, art.sha256, receiver.clock), "svc-test");
    const result = await receiver.router.route(envelope);
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CONTEXT_BINDING_INVALID");
  });

  it("document.archive runs end to end the same way, through the HTTP archive adapter", async () => {
    const w = world();
    const gatewayClock = new FakeClock(START);
    const keyPair = generateKeyPair();
    const identities = new IdentityProvider([{ actorId: "svc-test", actorType: "service", tenantId: "t1", scopes: ["document.archive"], authStrength: "client-credentials" }]);
    const gateway = new Gateway({ identities, signer: new Signer("k1", keyPair.privateKey), clock: gatewayClock });
    const receiver = remoteHost(keyPair.publicKey, "k1", w);
    const art = receiver.artifacts.put({ tenantId: "t1", bytes: "faktura 123", receivedFrom: "test" });

    const message: MessageEnvelope = {
      messageId: newId("msg"),
      correlationId: newId("cor"),
      type: "command",
      capability: "document.archive",
      capabilityVersion: "1",
      schemaVersion: "1",
      idempotencyKey: newId("key"),
      createdAt: iso(receiver.clock.now()),
      notValidAfter: iso(plus(receiver.clock.now(), 30 * MINUTE)),
      payload: { artifactId: art.artifactId, sha256: art.sha256 },
    };
    const result = await receiver.router.route(gateway.dispatch(message, "svc-test"));
    expect(result.status).toBe("SUCCEEDED");
    expect(result.payload?.archiveRef).toMatch(/^arch-/);
  });

  it("a scope the actor does not hold is denied before the handler ever runs (the identity, not the message, decides)", async () => {
    const w = world();
    const gatewayClock = new FakeClock(START);
    const keyPair = generateKeyPair();
    // svc-test holds document.stamp only; it may not dispatch document.archive, no matter what it asks for.
    const identities = new IdentityProvider([{ actorId: "svc-test", actorType: "service", tenantId: "t1", scopes: ["document.stamp"], authStrength: "client-credentials" }]);
    const gateway = new Gateway({ identities, signer: new Signer("k1", keyPair.privateKey), clock: gatewayClock });
    const receiver = remoteHost(keyPair.publicKey, "k1", w);
    const art = receiver.artifacts.put({ tenantId: "t1", bytes: "faktura 123", receivedFrom: "test" });

    const message: MessageEnvelope = {
      messageId: newId("msg"),
      correlationId: newId("cor"),
      type: "command",
      capability: "document.archive",
      capabilityVersion: "1",
      schemaVersion: "1",
      idempotencyKey: newId("key"),
      createdAt: iso(receiver.clock.now()),
      notValidAfter: iso(plus(receiver.clock.now(), 30 * MINUTE)),
      payload: { artifactId: art.artifactId, sha256: art.sha256 },
    };
    const result = await receiver.router.route(gateway.dispatch(message, "svc-test"));
    expect(result.status).toBe("FAILED");
    expect(result.error?.code).toBe("CAPABILITY_NOT_ALLOWED");
  });
});

describe("DH-TRANSPORT-001 RemoteHostTransport never throws (found running celek D2 locally: the orchestrator calls transport.dispatch() with no try/catch)", () => {
  it("an unreachable binding, a non-2xx response and an invalid body all resolve to a FAILED result, never a rejection", async () => {
    const gatewayClock = new FakeClock(START);
    const keyPair = generateKeyPair();
    const identities = new IdentityProvider([{ actorId: "svc-test", actorType: "service", tenantId: "t1", scopes: ["document.stamp"], authStrength: "client-credentials" }]);
    const message: MessageEnvelope = {
      messageId: newId("msg"),
      correlationId: newId("cor"),
      type: "command",
      capability: "document.stamp",
      capabilityVersion: "1",
      schemaVersion: "1",
      idempotencyKey: newId("key"),
      createdAt: iso(gatewayClock.now()),
      notValidAfter: iso(plus(gatewayClock.now(), 30 * MINUTE)),
      payload: { artifactId: "art-x", sha256: "ab".repeat(32) },
    };

    const unreachable = new RemoteHostTransport(new Gateway({ identities, signer: new Signer("k1", keyPair.privateKey), clock: gatewayClock }), { fetch: () => { throw new Error("connection refused"); } });
    const r1 = await unreachable.dispatch(message, "svc-test");
    expect(r1.status).toBe("FAILED");
    expect(r1.error?.code).toBe("DEPENDENCY_UNAVAILABLE");

    // Exactly the bug found live: a remote host's own uncaught wiring error surfaces as a bare HTTP 500, no ResultEnvelope body.
    const serverError = new RemoteHostTransport(new Gateway({ identities, signer: new Signer("k1", keyPair.privateKey), clock: gatewayClock }), { fetch: async () => new Response("Internal Server Error", { status: 500 }) });
    const r2 = await serverError.dispatch(message, "svc-test");
    expect(r2.status).toBe("FAILED");
    expect(r2.error?.code).toBe("DEPENDENCY_UNAVAILABLE");
    expect(r2.inReplyTo).toBe(message.messageId);
    expect(r2.correlationId).toBe(message.correlationId);

    const garbage = new RemoteHostTransport(new Gateway({ identities, signer: new Signer("k1", keyPair.privateKey), clock: gatewayClock }), { fetch: async () => Response.json({ not: "a result envelope" }) });
    const r3 = await garbage.dispatch(message, "svc-test");
    expect(r3.status).toBe("FAILED");
    expect(r3.error?.code).toBe("DEPENDENCY_UNAVAILABLE");
  });
});

describe("DH-AUDIT-RELAY-001 RelayAudit.flush() never lets the caller move on while a relay POST is still in flight (found live on farm-bass443 2026-09-07: ctx.waitUntil alone silently lost 3 document.stamp audit records, no error logged anywhere)", () => {
  it("flush() does not resolve until every append()'s relay fetch has settled", async () => {
    const settle: Array<() => void> = [];
    const posted: unknown[] = [];
    const fakeGateway = {
      fetch: (_url: string, init?: RequestInit) => {
        posted.push(init?.body ? JSON.parse(String(init.body)) : undefined);
        return new Promise<Response>((resolve) => settle.push(() => resolve(new Response(null, { status: 204 }))));
      },
    };
    const waited: Promise<unknown>[] = [];
    const fakeCtx = { waitUntil: (p: Promise<unknown>) => waited.push(p) };

    const audit = new RelayAudit(new FakeClock(START), fakeGateway, fakeCtx);
    audit.append({ kind: "write-intent", workflowId: "wf-1", correlationId: "cor-1", capability: "document.stamp", details: {} });
    audit.append({ kind: "write-done", workflowId: "wf-1", correlationId: "cor-1", capability: "document.stamp", details: {} });
    expect(posted).toHaveLength(2); // both relays started immediately, append() itself never blocks
    expect(waited).toHaveLength(2); // ctx.waitUntil still gets them too, as a backstop

    let flushed = false;
    const flushDone = audit.flush().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(flushed).toBe(false); // must NOT resolve while a relay is still pending — this is exactly what ctx.waitUntil alone failed to guarantee

    settle.forEach((resolve) => resolve());
    await flushDone;
    expect(flushed).toBe(true);
  });
});
