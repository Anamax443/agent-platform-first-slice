/**
 * MOJE daně (Finanční správa) VAT reliability + published bank accounts: the external dependency of
 * cz.vat.verify. SOAP 1.1 service `rozhraniCRPDPH`, operation `getStatusNespolehlivySubjektRozsirenyV2`
 * (WSDL: https://adisrws.mfcr.cz/dpr/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP?wsdl).
 *
 * Verified against the real endpoint 13. 9. 2026 (curl, not docs):
 *  - 200, statusCode 0, one `statusSubjektu` per requested `dic` (batch-native — up to 100/request per
 *    the WSDL's StatusType doc, this adapter deliberately only ever sends one).
 *  - Unlike ARES, "DIČ neexistuje" is NOT an HTTP-level signal: it comes back as a normal 200 with
 *    `nespolehlivyPlatce="NENALEZEN"` inside the same successful envelope — no exception for it here,
 *    the handler reads it off `reliability`/`found` like any other field (still SUCCEEDED downstream,
 *    same "business result, not error" pattern as cz.company.verify's not-found and document.classify's
 *    OTHER — the shape just differs because MOJE daně's own protocol differs from ARES's).
 *  - A malformed body (bad operation, garbage XML) comes back as HTTP 500 with a SOAP Fault
 *    (<soapenv:Fault><faultcode>soapenv:Server</faultcode>...) — mapped to MojeDaneUnavailable.
 *  - `status/@statusCode` 2 = planned maintenance window (00:00–00:10 daily, per WSDL annotation), 3 =
 *    service unavailable — both normal 200 responses, both mapped to MojeDaneUnavailable (retryable).
 */
import { XMLParser } from "fast-xml-parser";
import { TrustedProviderNotConfigured } from "../platform/errors.js";

export interface VatAccount {
  kind: "standard" | "other";
  cislo: string;
  predcisli?: string;
  kodBanky?: string;
  publishedOn: string;
  endedOn: string | null;
}

export interface VatSubjectStatus {
  dic: string;
  reliability: "ANO" | "NE" | "NENALEZEN";
  /** Same bit as cz.company.verify's `found` — kept as a separate, explicit field rather than making
   * callers infer it from `reliability === "NENALEZEN"` (INT-FAIL-004-style: don't make consumers
   * re-derive a business fact from a string enum). */
  found: boolean;
  companyName: string | null;
  publishedAccounts: VatAccount[];
}

export interface MojeDaneAdapter {
  lookup(dic: string): Promise<VatSubjectStatus>;
}

export class MojeDaneUnavailable extends Error {
  readonly httpStatus = 503;
  constructor(detail?: string) {
    super(detail ? `MOJE daně unavailable: ${detail}` : "MOJE daně unavailable (503)");
    this.name = "MojeDaneUnavailable";
  }
}

export type MojeDaneMode = "ok" | "timeout" | "unavailable" | "maintenance" | "nonsense";

const TABLE: Record<string, VatSubjectStatus> = {
  "27074358": {
    dic: "27074358",
    reliability: "NE",
    found: true,
    companyName: "Testovací Spolehlivý s.r.o.",
    publishedAccounts: [{ kind: "standard", cislo: "1657960", kodBanky: "0300", publishedOn: "2020-01-01", endedOn: null }],
  },
  "99999999": { dic: "99999999", reliability: "ANO", found: true, companyName: "Testovací Nespolehlivý a.s.", publishedAccounts: [] },
};

/** Fake with failure modes. It knows no business logic: nonsense modes just return prepared values. */
export class FakeMojeDaneAdapter implements MojeDaneAdapter {
  calls = 0;
  constructor(public mode: MojeDaneMode = "ok") {}

  async lookup(dic: string): Promise<VatSubjectStatus> {
    this.calls += 1;
    switch (this.mode) {
      case "timeout":
        return new Promise<VatSubjectStatus>(() => {});
      case "unavailable":
        throw new MojeDaneUnavailable("HTTP 500 (SOAP Fault)");
      case "maintenance":
        throw new MojeDaneUnavailable("statusCode 2: technologická odstávka 0:00-0:10");
      case "nonsense":
        // Schema-valid-looking JSON, semantically broken: reliability outside the ANO/NE/NENALEZEN enum
        // (INT-FAIL-004a-style range violation) and publishedAccounts not even an array.
        return { dic, reliability: "MAYBE" as unknown as "NE", found: true, companyName: null, publishedAccounts: "not-an-array" as unknown as VatAccount[] };
      default: {
        const r = TABLE[dic];
        if (r) return { ...r, publishedAccounts: r.publishedAccounts.map((a) => ({ ...a })) };
        return { dic, reliability: "NENALEZEN", found: false, companyName: null, publishedAccounts: [] };
      }
    }
  }
}

/**
 * Reliability Gate R4 — mirror of ares.ts's NotConfiguredAresAdapter (see that class's doc comment for the
 * full rationale). platform-wiring.ts's wirePlatform() constructs this instead of FakeMojeDaneAdapter when
 * the installation has neither a real `mojeDane` adapter wired nor
 * InstallationProfile.allowUnconfiguredTrustedProviders:true.
 */
export class NotConfiguredMojeDaneAdapter implements MojeDaneAdapter {
  async lookup(_dic: string): Promise<VatSubjectStatus> {
    throw new TrustedProviderNotConfigured("mojeDane");
  }
}

/** The minimum of fetch a client adapter needs: a Worker service binding (`Fetcher`), global fetch, or an in-process handler in tests. */
export interface HttpClient {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

function buildRequest(namespace: string, dic: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:roz="${namespace}"><soapenv:Body><roz:StatusNespolehlivySubjektRozsirenyV2Request><roz:dic>${dic}</roz:dic></roz:StatusNespolehlivySubjektRozsirenyV2Request></soapenv:Body></soapenv:Envelope>`;
}

function accountFrom(ucet: Record<string, unknown>): VatAccount {
  const publishedOn = String(ucet["@_datumZverejneni"] ?? "");
  const endedOn = ucet["@_datumZverejneniUkonceni"] != null ? String(ucet["@_datumZverejneniUkonceni"]) : null;
  const standard = ucet.standardniUcet as Record<string, unknown> | undefined;
  if (standard) {
    const out: VatAccount = { kind: "standard", cislo: String(standard["@_cislo"] ?? ""), publishedOn, endedOn };
    if (standard["@_predcisli"] != null) out.predcisli = String(standard["@_predcisli"]);
    if (standard["@_kodBanky"] != null) out.kodBanky = String(standard["@_kodBanky"]);
    return out;
  }
  const other = ucet.nestandardniUcet as Record<string, unknown> | undefined;
  return { kind: "other", cislo: String(other?.["@_cislo"] ?? ""), publishedOn, endedOn };
}

/**
 * MOJE daně over real SOAP/HTTP. This adapter only maps transport, HTTP status and the envelope's own
 * status/statusCode to the adapter's error classes; the handler validates shape and semantics of a
 * successful response (INT-FAIL-004 pattern, same split as HttpRegistryAdapter/HttpAresAdapter). No
 * default `baseUrl` or `namespace`: the real host and the WSDL's `rozhraniCRPDPH/` namespace are both
 * installation-shaped values that name the real `adis.mfcr.cz` service (ARCH-DEP-001's hostname lint —
 * hit for real, same as HttpAresAdapter), not hardcoded here. The generic SOAP 1.1 envelope namespace
 * (`schemas.xmlsoap.org`) stays a literal in `buildRequest()` — that one is a universal protocol
 * constant, identical for every SOAP 1.1 message ever sent by anyone, not an installation value; see
 * `scripts/arch-dep.mjs`'s `PROTOCOL_NAMESPACE_EXEMPT`.
 */
export class HttpMojeDaneAdapter implements MojeDaneAdapter {
  calls = 0;
  constructor(
    private readonly client: HttpClient,
    private readonly baseUrl: string,
    private readonly namespace: string,
  ) {}

  async lookup(dic: string): Promise<VatSubjectStatus> {
    this.calls += 1;
    let res: Response;
    try {
      res = await this.client.fetch(this.baseUrl, {
        method: "POST",
        headers: { "content-type": "text/xml; charset=UTF-8", soapaction: `${this.namespace}getStatusNespolehlivySubjektRozsirenyV2` },
        body: buildRequest(this.namespace, dic),
      });
    } catch (e) {
      throw new MojeDaneUnavailable(`unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    if (res.status >= 400) throw new MojeDaneUnavailable(`HTTP ${res.status}`);
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_", removeNSPrefix: true });
    const parsed = parser.parse(text) as Record<string, unknown>;
    const envelope = parsed.Envelope as Record<string, unknown> | undefined;
    const body = envelope?.Body as Record<string, unknown> | undefined;
    const response = body?.StatusNespolehlivySubjektRozsirenyResponse as Record<string, unknown> | undefined;
    if (!response) throw new MojeDaneUnavailable("response missing StatusNespolehlivySubjektRozsirenyResponse");
    const status = response.status as Record<string, unknown> | undefined;
    const statusCode = Number(status?.["@_statusCode"]);
    if (statusCode === 2 || statusCode === 3) throw new MojeDaneUnavailable(`statusCode ${statusCode}: ${String(status?.["@_statusText"] ?? "")}`);
    const raw = response.statusSubjektu;
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const subject = (list as Record<string, unknown>[]).find((s) => s["@_dic"] === dic) ?? list[0];
    if (!subject) throw new MojeDaneUnavailable("response carried no statusSubjektu");
    const reliability = subject["@_nespolehlivyPlatce"] as VatSubjectStatus["reliability"];
    const ucty = subject.zverejneneUcty as Record<string, unknown> | undefined;
    const ucetRaw = ucty?.ucet;
    const ucetList = Array.isArray(ucetRaw) ? ucetRaw : ucetRaw ? [ucetRaw] : [];
    return {
      dic,
      reliability,
      found: reliability !== "NENALEZEN",
      companyName: typeof subject.nazevSubjektu === "string" ? subject.nazevSubjektu.trim() : null,
      publishedAccounts: (ucetList as Record<string, unknown>[]).map(accountFrom),
    };
  }
}
