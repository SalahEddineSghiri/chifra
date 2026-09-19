import { useEffect, useState } from "react";
import { z } from "zod";

const allocationSchema = z.object({
  documentId: z.string().uuid(),
  invoiceNumber: z.string().nullable(),
  amountMad: z.string(),
});
const lineSchema = z.object({
  bankLineId: z.string().uuid(),
  bookedOn: z.string(),
  label: z.string(),
  classification: z.enum([
    "PURCHASE_CANDIDATE", "SALARY", "BANK_FEE", "CLIENT_RECEIPT", "OTHER",
  ]),
  status: z.enum([
    "FULLY_MATCHED", "PARTIALLY_ALLOCATED", "UNMATCHED",
    "REVIEW_REQUIRED", "EXCLUDED", "WAITING",
  ]),
  supplierName: z.string().nullable(),
  paymentAmountMad: z.string(),
  allocatedAmountMad: z.string(),
  unallocatedAmountMad: z.string(),
  reason: z.string(),
  candidateDocumentIds: z.array(z.string().uuid()),
  allocations: z.array(allocationSchema),
});
const documentSchema = z.object({
  documentId: z.string().uuid(),
  invoiceNumber: z.string().nullable(),
  supplierName: z.string().nullable(),
  issuedOn: z.string().nullable(),
  amountTtcMad: z.string().nullable(),
  paidAmountMad: z.string(),
  residualMad: z.string().nullable(),
  status: z.enum(["MATCHED", "PARTIAL", "UNMATCHED", "NOT_ELIGIBLE"]),
});
const summarySchema = z.object({
  eligiblePaymentLines: z.number().int().nonnegative(),
  fullyMatchedLines: z.number().int().nonnegative(),
  partiallyAllocatedLines: z.number().int().nonnegative(),
  reviewRequiredLines: z.number().int().nonnegative(),
  unmatchedLines: z.number().int().nonnegative(),
  excludedLines: z.number().int().nonnegative(),
  waitingLines: z.number().int().nonnegative(),
  matchRatePercent: z.string().nullable(),
});
const reconciliationSchema = z.object({
  id: z.string().uuid(),
  engineVersion: z.string(),
  proofId: z.string().uuid(),
  proof: z.object({
    id: z.string().uuid(),
    toolName: z.string(),
    toolVersion: z.string(),
    executedAt: z.iso.datetime(),
    metadata: z.object({
      rulesVersion: z.string(),
      currency: z.literal("MAD"),
      roundingConvention: z.string(),
      paymentWindowDays: z.number().int().positive(),
      maximumGroupSize: z.number().int().positive(),
      maximumGroupCandidates: z.number().int().positive(),
    }),
    documentSources: z.array(z.object({
      documentId: z.string().uuid(),
      sourceId: z.string().uuid(),
      tabularRecordId: z.string().uuid().nullable(),
      extractionId: z.string().uuid().nullable(),
      extractionMethod: z.string().nullable(),
      extractionVersion: z.string().nullable(),
    })),
  }),
  createdAt: z.iso.datetime(),
  summary: summarySchema,
  lines: z.array(lineSchema),
  documents: z.array(documentSchema),
});
const responseSchema = z.object({
  batchStatus: z.string(),
  job: z.object({
    id: z.string().uuid(),
    status: z.enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED"]),
    failureReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  }).nullable(),
  reconciliation: reconciliationSchema.nullable(),
});
type ReconciliationData = z.infer<typeof reconciliationSchema>;
type ReconciliationJob = z.infer<typeof responseSchema>["job"];

const lineStatusLabels = {
  FULLY_MATCHED: "Rapprochée",
  PARTIALLY_ALLOCATED: "Allocation partielle",
  UNMATCHED: "Non rapprochée",
  REVIEW_REQUIRED: "Revue requise",
  EXCLUDED: "Exclue",
  WAITING: "À qualifier",
} as const;
const documentStatusLabels = {
  MATCHED: "Payée",
  PARTIAL: "Partiellement payée",
  UNMATCHED: "Non payée",
  NOT_ELIGIBLE: "Hors calcul automatique",
} as const;

async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `Erreur HTTP ${response.status}`);
  }
  return body;
}

export function Reconciliation({ batchId, batchStatus }: {
  batchId: string;
  batchStatus: string;
}) {
  const [data, setData] = useState<ReconciliationData | null>(null);
  const [job, setJob] = useState<ReconciliationJob>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const parsed = responseSchema.parse(await readJson(
      await fetch(`/api/batches/${batchId}/reconciliation`),
    ));
    setJob(parsed.job);
    setData(parsed.reconciliation);
  }

  useEffect(() => {
    void load().catch(() => setError("Impossible de charger le rapprochement."));
    if (batchStatus !== "COMPLETED" || data !== null) return;
    const timer = setInterval(() => {
      void load().catch(() => setError("Impossible de charger le rapprochement."));
    }, 2000);
    return () => clearInterval(timer);
  }, [batchId, batchStatus, data !== null]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const parsed = responseSchema.parse(await readJson(await fetch(
        `/api/batches/${batchId}/reconciliation`, { method: "POST" },
      )));
      setJob(parsed.job);
      setData(parsed.reconciliation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Rapprochement impossible.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-labelledby="reconciliation-title" className="panel">
      <h2 id="reconciliation-title">Rapprochement bancaire</h2>
      {batchStatus !== "COMPLETED" && (
        <p>Le rapprochement devient disponible après la fermeture et la consolidation du lot.</p>
      )}
      {batchStatus === "COMPLETED" && data === null && job === null && (
        <>
          <p>Le calcul utilise les montants décimaux, le fournisseur, la date et les références observées. Une association ambiguë reste en revue humaine.</p>
          <button type="button" onClick={() => void run()} disabled={running}>
            {running ? "Rapprochement…" : "Lancer le rapprochement"}
          </button>
        </>
      )}
      {job && data === null && job.status !== "FAILED" && (
        <p>Rapprochement en cours dans le worker : {job.status}.</p>
      )}
      {job?.status === "FAILED" && data === null && (
        <p role="alert" className="error">{job.failureReason ?? "Le rapprochement a échoué."}</p>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {data && (
        <>
          <p className="meta-line">
            Moteur {data.engineVersion} — règles {data.proof.metadata.rulesVersion}
            {` — arrondi ${data.proof.metadata.roundingConvention} — preuve ${data.proofId}`}
          </p>
          <p className="meta-line">
            {data.proof.documentSources.length} référence(s) de source ou extraction conservée(s).
          </p>
          <div className="summary-grid">
            <span>
              <strong>{data.summary.matchRatePercent === null ? "—" : `${data.summary.matchRatePercent} %`}</strong>
              taux ({data.summary.fullyMatchedLines}/{data.summary.eligiblePaymentLines})
            </span>
            <span><strong>{data.summary.partiallyAllocatedLines}</strong> partielles</span>
            <span><strong>{data.summary.reviewRequiredLines}</strong> à revoir</span>
            <span><strong>{data.summary.unmatchedLines}</strong> non rapprochées</span>
            <span><strong>{data.summary.excludedLines}</strong> exclues</span>
            <span><strong>{data.summary.waitingLines}</strong> à qualifier</span>
          </div>
          <h3>Lignes bancaires</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date et libellé</th><th>État</th><th>Paiement</th>
                  <th>Alloué</th><th>Non alloué</th><th>Décision et allocations</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((line) => (
                  <tr key={line.bankLineId}>
                    <td>{line.bookedOn}<small className="cell-detail">{line.label}</small></td>
                    <td>{lineStatusLabels[line.status]}</td>
                    <td className="amount">{line.paymentAmountMad}</td>
                    <td className="amount">{line.allocatedAmountMad}</td>
                    <td className="amount">{line.unallocatedAmountMad}</td>
                    <td>
                      {line.reason}
                      {line.allocations.length > 0 && (
                        <ul className="compact-list">
                          {line.allocations.map((allocation) => (
                            <li key={allocation.documentId}>
                              {allocation.invoiceNumber ?? allocation.documentId} : {allocation.amountMad} MAD
                            </li>
                          ))}
                        </ul>
                      )}
                      {line.status === "REVIEW_REQUIRED" && line.candidateDocumentIds.length > 0 && (
                        <small className="cell-detail">
                          {line.candidateDocumentIds.length} pièce(s) candidate(s), aucune allocation appliquée
                        </small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <h3>Résiduels des pièces</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Pièce</th><th>Fournisseur</th><th>TTC</th><th>Payé</th><th>Résiduel</th><th>État</th></tr>
              </thead>
              <tbody>
                {data.documents.map((document) => (
                  <tr key={document.documentId}>
                    <td>{document.invoiceNumber ?? document.documentId}</td>
                    <td>{document.supplierName ?? "Non lu"}</td>
                    <td className="amount">{document.amountTtcMad ?? "—"}</td>
                    <td className="amount">{document.paidAmountMad}</td>
                    <td className="amount">{document.residualMad ?? "—"}</td>
                    <td>{documentStatusLabels[document.status]}</td>
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
