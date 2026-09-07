// Visual stamp burned into the original binary (PDF, JPG, PNG) — additive to the existing text-based DMS write
// (owner's decision 2026-09-07: "vedle sebe", not a replacement). Mirrors what an accountant used to do by hand
// before scanning a document: a visible mark that the system processed it, with a timestamp and reference.
// The original itself in `originals/<tenant>/<sha256>` is never touched — this writes a separate derived object.
import { PDFDocument, rgb, degrees, StandardFonts } from "pdf-lib";

export interface StampInfo {
  label: string;
  at: string;
  ref: string;
}

const isPdf = (contentType: string): boolean => contentType === "application/pdf";
const isRasterImage = (contentType: string): boolean => contentType === "image/jpeg" || contentType === "image/png";

/** Same red rotated box on every page (owner's decision: "je to informace o zpracování systémem", not just page 1). */
async function stampPdf(bytes: ArrayBuffer, info: StampInfo): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const red = rgb(0.75, 0.05, 0.05);
  for (const page of pdf.getPages()) {
    const { width } = page.getSize();
    const boxW = 220;
    const boxH = 70;
    const x = width - boxW - 40;
    const y = 40;
    page.drawRectangle({ x, y, width: boxW, height: boxH, borderColor: red, borderWidth: 2.5, rotate: degrees(-8) });
    page.drawText(info.label, { x: x + 18, y: y + 42, size: 15, font, color: red, rotate: degrees(-8) });
    page.drawText(info.at, { x: x + 14, y: y + 24, size: 9, font, color: red, rotate: degrees(-8) });
    page.drawText(`ref: ${info.ref}`, { x: x + 14, y: y + 9, size: 8, font, color: red, rotate: degrees(-8) });
  }
  return pdf.save();
}

/**
 * Cloudflare's Images binding renders text natively (`.text()`) and composites it onto the original (`.draw()`) —
 * no WASM dependency needed. Trade-off vs. the PDF path: ImageDrawOptions has no rotate, so this stamp sits flat
 * at a corner instead of tilted like the PDF's rubber-stamp box.
 */
async function stampImage(bytes: ArrayBuffer, contentType: string, info: StampInfo, images: ImagesBinding, fontUrl: string): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const overlay = images.text(`${info.label}\n${info.at}\nref: ${info.ref}`, { font: { url: fontUrl }, size: 22, color: "#bf0d0d" });
  const format = contentType === "image/png" ? "image/png" : "image/jpeg";
  const stream = new Response(bytes).body as ReadableStream<Uint8Array>;
  const result = await images.input(stream).draw(overlay, { bottom: 24, right: 24, opacity: 1 }).output({ format });
  return { bytes: await new Response(result.image()).arrayBuffer(), contentType: result.contentType() };
}

/**
 * null = no visual stamp defined for this content type yet (text originals, docx, …) — not every original is stampable.
 * `fontUrl` is an installation value (config/<installation>/farm.json `apf-gateway.vars.STAMP_FONT_URL`, ARCH-DEP-001
 * forbids a literal hostname in this file even though the same public font URL works for every installation).
 */
export async function visuallyStamp(bytes: ArrayBuffer, contentType: string, info: StampInfo, images: ImagesBinding, fontUrl: string): Promise<{ bytes: ArrayBuffer | Uint8Array; contentType: string } | null> {
  if (isPdf(contentType)) return { bytes: await stampPdf(bytes, info), contentType: "application/pdf" };
  if (isRasterImage(contentType)) return stampImage(bytes, contentType, info, images, fontUrl);
  return null;
}
