import {
  extractJpegOcr, extractPdfOcr, OCR_VERSION, OcrResourceLimitError,
} from "./ocr.js";
import { extractPdfNativeText, type TextSegment } from "./pdf.js";

export const PDF_TEXT_VERSION = "poppler-v1";
export type ExtractionMethod = "PDF_TEXT" | "OCR";
export type ExtractionAttempt = {
  method: ExtractionMethod;
  version: string;
  status: "SUCCEEDED" | "NON_TRAITE" | "FAILED";
  segments: TextSegment[];
  reason: string | null;
};
export type SelectedSegment = TextSegment & { method: ExtractionMethod; version: string };
export type ProcessingOutcome = {
  status: "DONE" | "NON_TRAITE" | "FAILED";
  reason: string | null;
  attempts: ExtractionAttempt[];
  selectedSegments: SelectedSegment[];
};

export class SourceTechnicalError extends Error {
  constructor(
    readonly method: ExtractionMethod,
    readonly attempts: ExtractionAttempt[],
    readonly publicReason: string,
  ) {
    super(publicReason);
    this.name = "SourceTechnicalError";
  }
}

export function extractionAttempt(
  method: ExtractionMethod,
  version: string,
  status: ExtractionAttempt["status"],
  segments: TextSegment[],
  reason: string | null,
): ExtractionAttempt {
  return { method, version, status, segments, reason };
}

function selected(item: ExtractionAttempt): SelectedSegment[] {
  return item.segments.map((segment) => ({
    ...segment, method: item.method, version: item.version,
  }));
}

async function processPdf(path: string): Promise<ProcessingOutcome> {
  let native;
  try {
    native = await extractPdfNativeText(path);
  } catch {
    throw new SourceTechnicalError(
      "PDF_TEXT", [], "Erreur technique de lecture PDF après 3 tentatives.",
    );
  }
  if (native.status === "NON_TRAITE") {
    const failed = extractionAttempt(
      "PDF_TEXT", PDF_TEXT_VERSION, "NON_TRAITE", [], native.reason,
    );
    return { status: "NON_TRAITE", reason: native.reason, attempts: [failed], selectedSegments: [] };
  }

  const nativeAttempt = native.segments.length > 0
    ? extractionAttempt("PDF_TEXT", PDF_TEXT_VERSION, "SUCCEEDED", native.segments, null)
    : extractionAttempt(
      "PDF_TEXT", PDF_TEXT_VERSION, "NON_TRAITE", [], "Aucune couche texte exploitable.",
    );
  if (native.missingPages.length === 0) {
    return {
      status: "DONE", reason: null, attempts: [nativeAttempt],
      selectedSegments: selected(nativeAttempt),
    };
  }

  let ocr;
  try {
    ocr = await extractPdfOcr(path, native.missingPages);
  } catch (error) {
    if (error instanceof OcrResourceLimitError) {
      const limited = extractionAttempt(
        "OCR", OCR_VERSION, "NON_TRAITE", [], "Texte OCR supérieur à 2 Mo.",
      );
      return {
        status: "NON_TRAITE", reason: limited.reason,
        attempts: [nativeAttempt, limited], selectedSegments: selected(nativeAttempt),
      };
    }
    const failed = extractionAttempt(
      "OCR", OCR_VERSION, "FAILED", [], "Erreur technique OCR après 3 tentatives.",
    );
    throw new SourceTechnicalError(
      "OCR", [nativeAttempt, failed], "Erreur technique OCR après 3 tentatives.",
    );
  }
  const unreadableReason = ocr.unreadablePages.length > 0
    ? `Document illisible après OCR sur les pages ${ocr.unreadablePages.join(", ")}.`
    : null;
  const ocrAttempt = ocr.segments.length > 0
    ? extractionAttempt("OCR", OCR_VERSION, "SUCCEEDED", ocr.segments, null)
    : extractionAttempt("OCR", OCR_VERSION, "NON_TRAITE", [], unreadableReason);
  return {
    status: unreadableReason === null ? "DONE" : "NON_TRAITE",
    reason: unreadableReason,
    attempts: [nativeAttempt, ocrAttempt],
    selectedSegments: [...selected(nativeAttempt), ...selected(ocrAttempt)]
      .sort((left, right) => left.page - right.page),
  };
}

async function processJpeg(path: string): Promise<ProcessingOutcome> {
  let ocr;
  try {
    ocr = await extractJpegOcr(path);
  } catch (error) {
    if (error instanceof OcrResourceLimitError) {
      const limited = extractionAttempt(
        "OCR", OCR_VERSION, "NON_TRAITE", [], "Texte OCR supérieur à 2 Mo.",
      );
      return {
        status: "NON_TRAITE", reason: limited.reason,
        attempts: [limited], selectedSegments: [],
      };
    }
    const failed = extractionAttempt(
      "OCR", OCR_VERSION, "FAILED", [], "Erreur technique OCR après 3 tentatives.",
    );
    throw new SourceTechnicalError("OCR", [failed], "Erreur technique OCR après 3 tentatives.");
  }
  const reason = ocr.unreadablePages.length > 0
    ? "Document illisible : aucun texte exploitable après OCR."
    : null;
  const ocrAttempt = ocr.segments.length > 0
    ? extractionAttempt("OCR", OCR_VERSION, "SUCCEEDED", ocr.segments, null)
    : extractionAttempt("OCR", OCR_VERSION, "NON_TRAITE", [], reason);
  return {
    status: reason === null ? "DONE" : "NON_TRAITE",
    reason,
    attempts: [ocrAttempt],
    selectedSegments: selected(ocrAttempt),
  };
}

export async function extractSourceContent(mediaType: string, path: string) {
  return mediaType === "application/pdf" ? processPdf(path) : processJpeg(path);
}
