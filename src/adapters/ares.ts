/**
 * ARES (Registr ekonomických subjektů) company lookup: the external dependency of cz.company.verify.
 * GET https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico} — free, official (MF ČR).
 * Verified against the real endpoint 13. 9. 2026: 200 body carries `ico`/`obchodniJmeno`/`dic`/`datumZaniku`
 * (absent when the subject is active, not present-with-null) and `seznamRegistraci.stavZdrojeRes` ("AKTIVNI" |
 * other); 404 carries `{kod:"NENALEZENO", subKod:"VYSTUP_SUBJEKT_NENALEZEN"}`; a malformed IČO the client should
 * already have rejected via input schema comes back 400 `VSTUP_NEVALIDNI_FORMAT_ICO`. A 200 body is untrusted data
 * like any adapter response — the handler still checks shape before trusting it (INT-FAIL-004 pattern).
 */
import { TrustedProviderNotConfigured } from "../platform/errors.js";

export interface AresRecord {
  ico: string;
  obchodniJmeno: string;
  /** Null when the subject has not ceased; SEVERKA: "existuje ten subjekt vůbec" is `found`, this is a second, independent signal. */
  datumZaniku: string | null;
  /** `seznamRegistraci.stavZdrojeRes === "AKTIVNI"` — the base (RES) registry's own activity flag. */
  registraceAktivni: boolean;
}

export interface AresAdapter {
  lookup(ico: string): Promise<AresRecord>;
}

export class AresUnavailable extends Error {
  readonly httpStatus = 503;
  constructor(detail?: string) {
    super(detail ? `ARES unavailable: ${detail}` : "ARES unavailable (503)");
    this.name = "AresUnavailable";
  }
}

/** VYSTUP_SUBJEKT_NENALEZEN: not a technical fault — the IČO simply does not exist (SEVERKA: business result, like document.classify's OTHER). */
export class AresSubjectNotFound extends Error {
  constructor() {
    super("ARES subject not found (VYSTUP_SUBJEKT_NENALEZEN)");
    this.name = "AresSubjectNotFound";
  }
}

export type AresMode = "ok" | "timeout" | "unavailable" | "not-found" | "ceased" | "nonsense";

const TABLE: Record<string, AresRecord> = {
  "27074358": { ico: "27074358", obchodniJmeno: "Testovací Aktivní s.r.o.", datumZaniku: null, registraceAktivni: true },
  "87654321": { ico: "87654321", obchodniJmeno: "Testovací Zaniklá a.s.", datumZaniku: "2020-01-01", registraceAktivni: false },
};

/** Fake with failure modes. It knows no business logic: nonsense modes just return prepared values. */
export class FakeAresAdapter implements AresAdapter {
  calls = 0;
  constructor(public mode: AresMode = "ok") {}

  async lookup(ico: string): Promise<AresRecord> {
    this.calls += 1;
    switch (this.mode) {
      case "timeout":
        return new Promise<AresRecord>(() => {});
      case "unavailable":
        throw new AresUnavailable();
      case "not-found":
        throw new AresSubjectNotFound();
      case "ceased":
        return { ico, obchodniJmeno: "Testovací Zaniklá a.s.", datumZaniku: "2020-01-01", registraceAktivni: false };
      case "nonsense":
        // Schema-valid JSON, semantically broken: obchodniJmeno of the wrong type (INT-FAIL-004a-style range violation).
        return { ico, obchodniJmeno: 12345 as unknown as string, datumZaniku: null, registraceAktivni: true };
      default: {
        const r = TABLE[ico];
        if (!r) throw new AresSubjectNotFound();
        return { ...r };
      }
    }
  }
}

/**
 * Reliability Gate R4 (owner's second audit, 18.9.2026 — "než dáme Farmě větší autonomii, musí se nejdřív
 * sama umět... odhalit stagnaci", the systemic finding this class exists to close a concrete instance of):
 * platform-wiring.ts's wirePlatform() constructs this instead of FakeAresAdapter when the installation has
 * neither a real `ares` adapter wired nor InstallationProfile.allowUnconfiguredTrustedProviders:true — so a
 * missing configuration fails LOUD (TrustedProviderNotConfigured -> TRUSTED_PROVIDER_NOT_CONFIGURED) the
 * moment cz.company.verify is actually called, instead of silently returning fabricated ARES data as if it
 * were real (the exact gap the owner's audit named). Every method a real AresAdapter could be asked for
 * throws the same way — there is only one today (`lookup`), but a future addition should throw too, not
 * fall through to `undefined`.
 */
export class NotConfiguredAresAdapter implements AresAdapter {
  async lookup(_ico: string): Promise<AresRecord> {
    throw new TrustedProviderNotConfigured("ares");
  }
}

/** The minimum of fetch a client adapter needs: a Worker service binding (`Fetcher`), global fetch, or an in-process handler in tests. */
export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * ARES over real HTTP: GET /ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{ico} -> 200 record | 404
 * VYSTUP_SUBJEKT_NENALEZEN | 4xx/5xx. This adapter only maps transport and status codes to the adapter's error
 * classes; the handler validates shape and semantics of a 200 body (INT-FAIL-004 pattern, same split as
 * HttpRegistryAdapter/document.validate). No default `baseUrl`: the real host (ares.gov.cz) is an installation
 * value (ARCH-DEP-001) and belongs in config/<installation>/, supplied by whoever wires this adapter up for a
 * real installation — not baked into adapter code that must stay identical across every installation.
 */
export class HttpAresAdapter implements AresAdapter {
  calls = 0;
  constructor(
    private readonly client: HttpClient,
    private readonly baseUrl: string,
  ) {}

  async lookup(ico: string): Promise<AresRecord> {
    this.calls += 1;
    let res: Response;
    try {
      res = await this.client.fetch(`${this.baseUrl}/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/${ico}`);
    } catch (e) {
      throw new AresUnavailable(`unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) throw new AresSubjectNotFound();
    if (res.status >= 400) throw new AresUnavailable(`HTTP ${res.status}`);
    const body: unknown = await res.json().catch(() => undefined);
    if (!body || typeof body !== "object") return { ico, obchodniJmeno: "", datumZaniku: null, registraceAktivni: false };
    const b = body as Record<string, unknown>;
    const registrace = b.seznamRegistraci as Record<string, unknown> | undefined;
    return {
      ico: typeof b.ico === "string" ? b.ico : ico,
      obchodniJmeno: b.obchodniJmeno as never, // untyped on purpose: the handler must reject a non-string, not this adapter (INT-FAIL-004a).
      datumZaniku: typeof b.datumZaniku === "string" ? b.datumZaniku : null,
      registraceAktivni: registrace?.stavZdrojeRes === "AKTIVNI",
    };
  }
}
