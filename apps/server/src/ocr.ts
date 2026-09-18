import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { TextSegment } from "./pdf.js";

const run = promisify(execFile);
const OCR_TIMEOUT_MS = 60_000;
const RENDER_TIMEOUT_MS = 45_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const OCR_VERSION = "tesseract-5-fra-ara-eng-v2";

export class OcrTechnicalError extends Error {
  constructor() {
    super("Erreur technique OCR.");
    this.name = "OcrTechnicalError";
  }
}

export class OcrResourceLimitError extends Error {
  constructor() {
    super("Texte OCR trop volumineux.");
    this.name = "OcrResourceLimitError";
  }
}

export type OcrOutcome = {
  segments: TextSegment[];
  unreadablePages: number[];
};

function readable(text: string): boolean {
  return (text.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}

async function runTesseract(path: string): Promise<string> {
  try {
    const { stdout } = await run(
      "tesseract", [path, "stdout", "-l", "fra+ara+eng", "--psm", "6"],
      { encoding: "utf8", timeout: OCR_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
    );
    if (Buffer.byteLength(stdout, "utf8") > MAX_TEXT_BYTES) throw new OcrResourceLimitError();
    return stdout.trim();
  } catch (error) {
    if (error instanceof OcrResourceLimitError) throw error;
    throw new OcrTechnicalError();
  }
}

export async function extractJpegOcr(path: string): Promise<OcrOutcome> {
  const text = await runTesseract(path);
  return readable(text)
    ? { segments: [{ page: 1, text }], unreadablePages: [] }
    : { segments: [], unreadablePages: [1] };
}

export async function extractPdfOcr(path: string, pages: number[]): Promise<OcrOutcome> {
  const directory = await mkdtemp(join(tmpdir(), "chiffra-ocr-"));
  const segments: TextSegment[] = [];
  const unreadablePages: number[] = [];
  let totalBytes = 0;
  try {
    for (const page of pages) {
      const prefix = join(directory, `page-${page}`);
      try {
        await run(
          "pdftoppm",
          ["-f", String(page), "-l", String(page), "-scale-to", "3500", "-singlefile", "-jpeg", path, prefix],
          { encoding: "utf8", timeout: RENDER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        );
      } catch {
        throw new OcrTechnicalError();
      }
      const text = await runTesseract(`${prefix}.jpg`);
      if (!readable(text)) {
        unreadablePages.push(page);
        continue;
      }
      totalBytes += Buffer.byteLength(text, "utf8");
      if (totalBytes > MAX_TEXT_BYTES) throw new OcrResourceLimitError();
      segments.push({ page, text });
    }
    return { segments, unreadablePages };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
