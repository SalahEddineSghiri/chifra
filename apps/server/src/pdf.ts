import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_PAGES = 30;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export type TextSegment = { page: number; text: string };
export type PdfNativeOutcome =
  | { status: "READY"; pageCount: number; segments: TextSegment[]; missingPages: number[] }
  | { status: "NON_TRAITE"; reason: string };

export async function extractPdfNativeText(path: string): Promise<PdfNativeOutcome> {
  const { stdout: info } = await run("pdfinfo", [path], {
    encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024,
  });
  const match = /^Pages:\s+(\d+)$/m.exec(info);
  const pageCount = Number(match?.[1]);
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return { status: "NON_TRAITE", reason: "Nombre de pages PDF indéterminé." };
  }
  if (pageCount > MAX_PAGES) {
    return { status: "NON_TRAITE", reason: "PDF de plus de 30 pages non traité à cette étape." };
  }

  const segments: TextSegment[] = [];
  const missingPages: number[] = [];
  let totalBytes = 0;
  for (let page = 1; page <= pageCount; page += 1) {
    const { stdout } = await run(
      "pdftotext", ["-layout", "-enc", "UTF-8", "-f", String(page), "-l", String(page), path, "-"],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const text = stdout.trim();
    if (!text) {
      missingPages.push(page);
      continue;
    }
    totalBytes += Buffer.byteLength(text, "utf8");
    if (totalBytes > MAX_TEXT_BYTES) {
      return { status: "NON_TRAITE", reason: "Texte PDF trop volumineux pour cette étape." };
    }
    segments.push({ page, text });
  }

  return { status: "READY", pageCount, segments, missingPages };
}
