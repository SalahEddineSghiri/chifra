import { useEffect, useState } from "react";
import { z } from "zod";

const checkSchema = z.object({
  code: z.string(),
  family: z.enum([
    "ARITHMETIC", "VAT", "PERIOD", "SUPPLIER", "MANDATORY",
    "ACCOUNT", "ABNORMAL_AMOUNT", "DUPLICATE", "SOURCE",
  ]),
  status: z.enum(["PASS", "ANOMALY", "NOT_EVALUABLE"]),
  message: z.string(),
  observed: z.string().nullable(),
  expected: z.string().nullable(),
  differenceMad: z.string().nullable(),
  absoluteExposureMad: z.string().nullable(),
  missingFields: z.array(z.string()),
  relatedDocumentId: z.string().uuid().nullable(),
});
const supplierReferenceSchema = z.object({
  matchBy: z.enum(["ICE", "NAME"]),
  name: z.string(),
  ice: z.string(),
  category: z.string(),
  usualVatRate: z.string(),
  account: z.string(),
  averageTtcMad: z.string(),
});
const documentSchema = z.object({
  documentId: z.string().uuid(),
  invoiceNumber: z.string().nullable(),
  supplierName: z.string().nullable(),
  supplierIce: z.string().nullable(),
  issuedOn: z.string().nullable(),
  amountTtc: z.string().nullable(),
  status: z.enum(["PASS", "ANOMALY", "NOT_EVALUABLE"]),
  supplierReference: supplierReferenceSchema.nullable(),
  checks: z.array(checkSchema),
  sources: z.array(z.object({
    sourceId: z.string().uuid(),
    filename: z.string(),
    rowNumber: z.number().int().positive().nullable(),
  })),
});
const auditSchema = z.object({
  id: z.string().uuid(),
  engineVersion: z.string(),
  rulesVersion: z.string(),
  referenceVersion: z.string(),
  roundingConvention: z.string(),
  referenceHashes: z.record(z.string(), z.string()),
  createdAt: z.iso.datetime(),
  summary: z.object({
    documentCount: z.number().int().nonnegative(),
    passedDocumentCount: z.number().int().nonnegative(),
    anomalousDocumentCount: z.number().int().nonnegative(),
    nonEvaluableDocumentCount: z.number().int().nonnegative(),
    anomalyCount: z.number().int().nonnegative(),
    nonEvaluableCheckCount: z.number().int().nonnegative(),
    anomaliesByFamily: z.record(z.string(), z.number().int().nonnegative()),
  }),
  documents: z.array(documentSchema),
});
const responseSchema = z.object({
  batchStatus: z.string(),
  reference: z.object({
    version: z.string(),
    accountCount: z.number().int().nonnegative(),
    supplierCount: z.number().int().nonnegative(),
    hashes: z.record(z.string(), z.string()),
  }),
  job: z.object({
    id: z.string().uuid(),
    status: z.enum(["PENDING", "PROCESSING", "COMPLETED", "FAILED"]),
    failureReason: z.string().nullable(),
    createdAt: z.iso.datetime(),
    startedAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  }).nullable(),
  audit: auditSchema.nullable(),
});
type AuditData = z.infer<typeof auditSchema>;
type AuditJob = z.infer<typeof responseSchema>["job"];
type ReferenceSummary = z.infer<typeof responseSchema>["reference"];

const statusLabels = {
  PASS: "Sans anomalie détectée",
  ANOMALY: "Anomalie",
  NOT_EVALUABLE: "Non évaluable",
} as const;

async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `Erreur HTTP ${response.status}`);
  }
  return body;
}

export function Audit({ batchId, batchStatus }: { batchId: string; batchStatus: string }) {
  const [audit, setAudit] = useState<AuditData | null>(null);
  const [job, setJob] = useState<AuditJob>(null);
  const [reference, setReference] = useState<ReferenceSummary | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const parsed = responseSchema.parse(await readJson(
      await fetch(`/api/batches/${batchId}/audit`),
    ));
    setReference(parsed.reference);
    setJob(parsed.job);
    setAudit(parsed.audit);
  }

  useEffect(() => {
    void load().catch(() => setError("Impossible de charger l'audit."));
    if (batchStatus !== "COMPLETED" || audit !== null) return;
    const timer = setInterval(() => {
      void load().catch(() => setError("Impossible de charger l'audit."));
    }, 2000);
    return () => clearInterval(timer);
  }, [batchId, batchStatus, audit !== null]);

  async function run() {
    setRunning(true);
    setError(null);
    try {
      const parsed = responseSchema.parse(await readJson(await fetch(
        `/api/batches/${batchId}/audit`, { method: "POST" },
      )));
      setReference(parsed.reference);
      setJob(parsed.job);
      setAudit(parsed.audit);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Audit impossible.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-labelledby="audit-title" className="panel">
      <h2 id="audit-title">Contrôles comptables et fiscaux</h2>
      {reference && (
        <p className="meta-line">
          Référentiel {reference.version} : {reference.accountCount} comptes et {reference.supplierCount} fournisseurs.
        </p>
      )}
      {batchStatus !== "COMPLETED" && <p>L'audit devient disponible après consolidation.</p>}
      {batchStatus === "COMPLETED" && audit === null && job === null && (
        <button type="button" onClick={() => void run()} disabled={running}>
          {running ? "Démarrage…" : "Lancer les contrôles"}
        </button>
      )}
      {job && audit === null && job.status !== "FAILED" && (
        <p>Contrôles en cours dans le worker : {job.status}.</p>
      )}
      {job?.status === "FAILED" && audit === null && (
        <>
          <p role="alert" className="error">{job.failureReason ?? "L'audit a échoué."}</p>
          <button type="button" onClick={() => void run()} disabled={running}>
            {running ? "Relance…" : "Relancer les contrôles"}
          </button>
        </>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {audit && (
        <>
          <p className="meta-line">
            Moteur {audit.engineVersion} — règles {audit.rulesVersion}
            {` — arrondi ${audit.roundingConvention} — preuve ${audit.id}`}
          </p>
          <div className="summary-grid">
            <span><strong>{audit.summary.documentCount}</strong> pièces contrôlées</span>
            <span><strong>{audit.summary.passedDocumentCount}</strong> sans anomalie</span>
            <span><strong>{audit.summary.anomalousDocumentCount}</strong> avec anomalie</span>
            <span><strong>{audit.summary.nonEvaluableDocumentCount}</strong> non évaluables</span>
            <span><strong>{audit.summary.anomalyCount}</strong> causes détectées</span>
          </div>
          <p>Aucun total financier global n'est calculé en additionnant plusieurs anomalies sur une même pièce.</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th>Pièce et source</th><th>Observation</th><th>Référence</th><th>État</th><th>Contrôles</th></tr>
              </thead>
              <tbody>
                {audit.documents.map((document) => (
                  <tr key={document.documentId}>
                    <td>
                      {document.invoiceNumber ?? document.documentId}
                      {document.sources.map((source) => (
                        <small className="cell-detail" key={`${source.sourceId}-${source.rowNumber ?? "file"}`}>
                          {source.filename}{source.rowNumber ? `, ligne ${source.rowNumber}` : ""}
                        </small>
                      ))}
                    </td>
                    <td>
                      {document.supplierName ?? "Fournisseur non lu"}
                      <small className="cell-detail">ICE : {document.supplierIce ?? "absent"}</small>
                      <small className="cell-detail">TTC : {document.amountTtc ?? "absent"}</small>
                    </td>
                    <td>
                      {document.supplierReference ? (
                        <>
                          {document.supplierReference.name}
                          <small className="cell-detail">
                            TVA {document.supplierReference.usualVatRate} % — compte {document.supplierReference.account}
                          </small>
                        </>
                      ) : "Aucune correspondance"}
                    </td>
                    <td>{statusLabels[document.status]}</td>
                    <td>
                      <ul className="compact-list">
                        {document.checks.filter((item) => item.status !== "PASS").map((item) => (
                          <li className={item.status === "ANOMALY" ? "conflict" : ""} key={`${item.code}-${item.relatedDocumentId ?? "self"}`}>
                            {item.code} : {item.message}
                            {(item.observed !== null || item.expected !== null) && (
                              <small className="cell-detail">
                                observé {item.observed ?? "absent"} — attendu {item.expected ?? "inconnu"}
                              </small>
                            )}
                            {item.differenceMad !== null && (
                              <small className="cell-detail">
                                écart signé {item.differenceMad} MAD
                                {item.absoluteExposureMad !== null && ` — valeur absolue ${item.absoluteExposureMad} MAD`}
                              </small>
                            )}
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
