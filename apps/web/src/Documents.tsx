import { useEffect, useState } from "react";
import { z } from "zod";

const summarySchema = z.object({
  sourceCount: z.number().int().nonnegative(),
  nonTraiteCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
  readyCount: z.number().int().nonnegative(),
  reviewRequiredCount: z.number().int().nonnegative(),
  confirmedLinks: z.number().int().nonnegative(),
  openConflicts: z.number().int().nonnegative(),
});
const sourceSchema = z.object({
  sourceId: z.string().uuid(),
  filename: z.string(),
  tabularRecordId: z.string().uuid().nullable(),
  rowNumber: z.number().int().positive().nullable(),
  relationStatus: z.enum(["PRIMARY", "CONFIRMED", "CONFLICT_CANDIDATE"]),
});
const conflictSchema = z.object({
  id: z.string().uuid(),
  fieldName: z.string(),
  documentValue: z.string().nullable(),
  tabularValue: z.string().nullable(),
  reason: z.enum([
    "VALUE_MISMATCH", "MISSING_COMPARABLE_VALUE",
    "SOURCE_WITHOUT_OBSERVATIONS", "AMBIGUOUS_SOURCE_IDENTIFIER",
  ]),
  status: z.enum(["OPEN", "RESOLVED"]),
});
const documentSchema = z.object({
  id: z.string().uuid(),
  externalDocumentId: z.string().nullable(),
  kind: z.enum(["INVOICE", "CREDIT", "UNDETERMINED"]),
  status: z.enum(["READY", "REVIEW_REQUIRED"]),
  invoiceNumber: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierIce: z.string().nullable(),
  customerIce: z.string().nullable(),
  issuedOn: z.string().nullable(),
  account: z.string().nullable(),
  printedVatRate: z.string().nullable(),
  amountHt: z.string().nullable(),
  vatAmount: z.string().nullable(),
  amountTtc: z.string().nullable(),
  sources: z.array(sourceSchema),
  conflicts: z.array(conflictSchema),
});
const listSchema = z.object({
  batchStatus: z.string(),
  summary: summarySchema,
  documents: z.array(documentSchema),
});
const closeSchema = z.object({
  batch: z.object({ id: z.string().uuid(), status: z.literal("COMPLETED") }),
  summary: summarySchema,
});
type DocumentList = z.infer<typeof listSchema>;

const relationLabels = {
  PRIMARY: "source principale",
  CONFIRMED: "représentation confirmée",
  CONFLICT_CANDIDATE: "candidat en conflit",
} as const;
const conflictLabels = {
  VALUE_MISMATCH: "valeurs différentes",
  MISSING_COMPARABLE_VALUE: "comparaison incomplète",
  SOURCE_WITHOUT_OBSERVATIONS: "source sans champs exploitables",
  AMBIGUOUS_SOURCE_IDENTIFIER: "plusieurs sources portent cet identifiant",
} as const;

async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `Erreur HTTP ${response.status}`);
  }
  return body;
}

export function Documents({
  batchId, batchStatus, onCompleted,
}: {
  batchId: string;
  batchStatus: string;
  onCompleted: () => Promise<void>;
}) {
  const [data, setData] = useState<DocumentList | null>(null);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch(`/api/batches/${batchId}/documents`);
    setData(listSchema.parse(await readJson(response)));
  }

  useEffect(() => {
    void load().catch(() => setError("Impossible de charger les pièces métier."));
  }, [batchId, batchStatus]);

  async function closeBatch() {
    setClosing(true);
    setError(null);
    try {
      closeSchema.parse(await readJson(await fetch(`/api/batches/${batchId}/close`, {
        method: "POST",
      })));
      await onCompleted();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Fermeture du lot impossible.");
    } finally {
      setClosing(false);
    }
  }

  return (
    <section aria-labelledby="documents-title" className="panel">
      <h2 id="documents-title">Pièces métier du lot</h2>
      {batchStatus === "OPEN" && (
        <>
          <p>Fermez le lot lorsque tous les fichiers ont atteint un état terminal. Cette action bloque les nouveaux dépôts et compare les représentations PDF/JPG/XLSX.</p>
          <button type="button" onClick={() => void closeBatch()} disabled={closing}>
            {closing ? "Consolidation…" : "Fermer et consolider le lot"}
          </button>
        </>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {data && data.batchStatus === "COMPLETED" && (
        <>
          <div className="summary-grid">
            <span><strong>{data.summary.sourceCount}</strong> sources</span>
            <span><strong>{data.summary.documentCount}</strong> pièces</span>
            <span><strong>{data.summary.readyCount}</strong> prêtes</span>
            <span><strong>{data.summary.reviewRequiredCount}</strong> à revoir</span>
            <span><strong>{data.summary.confirmedLinks}</strong> liaisons confirmées</span>
            <span><strong>{data.summary.openConflicts}</strong> conflits ouverts</span>
          </div>
          <div className="table-scroll documents-table">
            <table>
              <thead>
                <tr>
                  <th>ID externe</th><th>Numéro</th><th>Fournisseur</th><th>Date</th>
                  <th>HT</th><th>TVA</th><th>TTC</th><th>État</th><th>Sources et conflits</th>
                </tr>
              </thead>
              <tbody>
                {data.documents.map((document) => (
                  <tr key={document.id}>
                    <td>{document.externalDocumentId ?? "—"}</td>
                    <td>{document.invoiceNumber ?? "Non lu"}</td>
                    <td>{document.supplierName ?? "Non lu"}</td>
                    <td>{document.issuedOn ?? "Non lue"}</td>
                    <td className="amount">{document.amountHt ?? "—"}</td>
                    <td className="amount">{document.vatAmount ?? "—"}</td>
                    <td className="amount">{document.amountTtc ?? "—"}</td>
                    <td>{document.status === "READY" ? "Prête" : "Revue requise"}</td>
                    <td>
                      <ul className="compact-list">
                        {document.sources.map((source) => (
                          <li key={`${source.sourceId}-${source.tabularRecordId ?? "file"}`}>
                            {source.filename}{source.rowNumber ? `, ligne ${source.rowNumber}` : ""}
                            {` — ${relationLabels[source.relationStatus]}`}
                          </li>
                        ))}
                        {document.conflicts.map((conflict) => (
                          <li className="conflict" key={conflict.id}>
                            {conflict.fieldName} : {conflictLabels[conflict.reason]}
                            {conflict.documentValue !== null || conflict.tabularValue !== null
                              ? ` (${conflict.documentValue ?? "absent"} / ${conflict.tabularValue ?? "absent"})`
                              : ""}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
