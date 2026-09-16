// Authority grants (docs/M0-FACT-CONTRACT-V1.md část C, step C-1): WHO is entitled to assert WHICH fact, decided by the
// installation (config/<installation>/authorities.json), never by a cow and never at runtime. The same authority layer
// as Policy and Lifecycle: a producer holds a grant for exactly one authority domain (e.g. cz.company.verify ->
// "cz.company.registry"), the grant names the facts that domain may attest and an upper bound on how long its evidence
// may be trusted. EvidenceWriter stamps the domain from the grant (a cow cannot raise its own trust) and refuses a
// fact outside the grant's scope — the same shape as Router refusing a scope outside a policy grant. A producer with
// no grant produces evidence without a domain: "inferred", never "authoritative" by self-declaration.
import { FACT_KEY_PATTERN } from "./fact-catalog.js";

export interface AuthorityGrantJson {
  producers: string[];
  /** Fact keys of the namespace this domain may attest, or exactly ["*"] for platform-level domains. */
  facts: string[];
  /** ISO 8601 duration (P30D, P1D, PT12H, P1DT6H) or null = evidence of this domain never expires by policy. */
  maxEvidenceTtl: string | null;
}

export interface AuthoritiesJson {
  $comment?: string;
  schemaVersion: string;
  domains: Record<string, AuthorityGrantJson>;
  /** Per-tenant overrides — reserved (M0 část C: "připraveno, prázdné"); anything but an empty object is refused. */
  tenants?: Record<string, unknown>;
}

export interface AuthorityGrant {
  readonly domain: string;
  readonly producers: readonly string[];
  readonly facts: readonly string[] | "*";
  readonly maxEvidenceTtl: string | null;
  readonly maxEvidenceTtlMs: number | null;
}

export class AuthorityError extends Error {
  constructor(message: string) {
    super(`authorities.json: ${message}`);
    this.name = "AuthorityError";
  }
}

const DOMAIN = /^[a-z][a-z0-9-]*(?:\.[a-zA-Z][a-zA-Z0-9-]*)*$/;
const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** P30D, P1D, PT12H, P1DT6H, PT30M → milliseconds. Anything else (including a bare "P" or "PT") throws. */
export function parseIsoDuration(text: string): number {
  const m = ISO_DURATION.exec(text);
  if (!m || text === "P" || text === "PT" || text.endsWith("T")) throw new AuthorityError(`not an ISO 8601 duration: ${JSON.stringify(text)} (expected e.g. P30D, PT12H, P1DT6H)`);
  const days = Number(m[1] ?? 0);
  const hours = Number(m[2] ?? 0);
  const minutes = Number(m[3] ?? 0);
  const ms = days * DAY + hours * HOUR + minutes * MINUTE;
  if (ms <= 0) throw new AuthorityError(`duration must be positive: ${JSON.stringify(text)}`);
  return ms;
}

export class AuthorityRegistry {
  private constructor(
    private readonly byProducer: ReadonlyMap<string, AuthorityGrant>,
    private readonly byDomain: ReadonlyMap<string, AuthorityGrant>,
  ) {}

  /** No grants at all: every producer is "inferred". The fail-closed default when an installation ships no authorities.json. */
  static empty(): AuthorityRegistry {
    return new AuthorityRegistry(new Map(), new Map());
  }

  static build(json: unknown): AuthorityRegistry {
    const a = json as AuthoritiesJson;
    if (!a || typeof a !== "object") throw new AuthorityError("not an object");
    if (a.schemaVersion !== "1") throw new AuthorityError(`expected schemaVersion "1", got ${JSON.stringify(a.schemaVersion)}`);
    if (!a.domains || typeof a.domains !== "object") throw new AuthorityError('"domains" must be an object');
    if (a.tenants !== undefined && (typeof a.tenants !== "object" || a.tenants === null || Object.keys(a.tenants).length > 0)) {
      throw new AuthorityError('"tenants" overrides are not supported yet — must be absent or {}');
    }
    const byProducer = new Map<string, AuthorityGrant>();
    const byDomain = new Map<string, AuthorityGrant>();
    for (const [domain, g] of Object.entries(a.domains)) {
      if (!DOMAIN.test(domain)) throw new AuthorityError(`domain ${JSON.stringify(domain)} is not a dotted lower-case name`);
      if (!g || typeof g !== "object") throw new AuthorityError(`${domain}: grant must be an object`);
      if (!Array.isArray(g.producers) || g.producers.some((p) => typeof p !== "string" || p.length === 0)) throw new AuthorityError(`${domain}: "producers" must be an array of non-empty strings`);
      if (!Array.isArray(g.facts) || g.facts.length === 0) throw new AuthorityError(`${domain}: "facts" must be a non-empty array (use ["*"] for a platform-level domain)`);
      let facts: readonly string[] | "*";
      if (g.facts.length === 1 && g.facts[0] === "*") facts = "*";
      else {
        for (const f of g.facts) if (typeof f !== "string" || !FACT_KEY_PATTERN.test(f)) throw new AuthorityError(`${domain}: fact ${JSON.stringify(f)} is not a namespace key`);
        facts = [...g.facts];
      }
      if (g.maxEvidenceTtl !== null && typeof g.maxEvidenceTtl !== "string") throw new AuthorityError(`${domain}: "maxEvidenceTtl" must be an ISO duration or null`);
      const grant: AuthorityGrant = {
        domain,
        producers: [...g.producers],
        facts,
        maxEvidenceTtl: g.maxEvidenceTtl,
        maxEvidenceTtlMs: g.maxEvidenceTtl === null ? null : parseIsoDuration(g.maxEvidenceTtl),
      };
      for (const p of grant.producers) {
        const other = byProducer.get(p);
        if (other) throw new AuthorityError(`producer ${p} is granted two domains (${other.domain}, ${domain}) — a producer holds exactly one`);
        byProducer.set(p, grant);
      }
      byDomain.set(domain, grant);
    }
    return new AuthorityRegistry(byProducer, byDomain);
  }

  /** The grant a producer holds, or undefined = no authority (its evidence stays "inferred"). */
  forProducer(producerId: string): AuthorityGrant | undefined {
    return this.byProducer.get(producerId);
  }

  grant(domain: string): AuthorityGrant | undefined {
    return this.byDomain.get(domain);
  }

  grants(): AuthorityGrant[] {
    return [...this.byDomain.values()];
  }
}
