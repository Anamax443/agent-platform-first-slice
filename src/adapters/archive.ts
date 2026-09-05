/** Archive store adapter: the second write target in the shared document executor host (document.archive). */
export interface ArchiveAdapter {
  put(input: { bytes: string; sha256: string; clientRef: string }, credential: string): Promise<{ ref: string }>;
}

export class FakeArchiveAdapter implements ArchiveAdapter {
  putCalls = 0;
  readonly stored = new Map<string, { bytes: string; sha256: string }>();
  constructor(private readonly expectedCredential = "archive-secret") {}

  async put(input: { bytes: string; sha256: string; clientRef: string }, credential: string): Promise<{ ref: string }> {
    if (credential !== this.expectedCredential) throw new Error("archive authentication failed");
    this.putCalls += 1;
    this.stored.set(input.clientRef, { bytes: input.bytes, sha256: input.sha256 });
    return { ref: `arch-${this.putCalls}` };
  }
}
