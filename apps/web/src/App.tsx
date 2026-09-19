import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { BankStatements } from "./BankStatements";
import { Documents } from "./Documents";
import { Reconciliation } from "./Reconciliation";

const batchSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  status: z.string(),
  createdAt: z.iso.datetime(),
});
const listSchema = z.object({ batches: z.array(batchSchema) });
const createSchema = z.object({ batch: batchSchema });
const normalizationSchema = z.enum([
  "ARABIC_INDIC_DIGITS_TO_LATIN",
  "PERSIAN_DIGITS_TO_LATIN",
  "ARABIC_DECIMAL_TO_DOT",
  "ARABIC_THOUSANDS_REMOVED",
  "GROUPING_SEPARATOR_REMOVED",
  "DECIMAL_COMMA_TO_DOT",
  "DATE_SEPARATOR_TO_HYPHEN",
  "DATE_COMPONENT_ZERO_PADDED",
]);
const observationCandidateSchema = z.object({
  rawValue: z.string(),
  value: z.string(),
  page: z.number().int().positive(),
  extractionMethod: z.enum(["PDF_TEXT", "OCR"]),
  extractionVersion: z.string(),
  normalization: z.array(normalizationSchema),
});
const observedFieldSchema = z.object({
  value: z.string().nullable(),
  rawValue: z.string().nullable().default(null),
  page: z.number().int().positive().nullable(),
  missingReason: z.string().nullable(),
  extractionMethod: z.enum(["PDF_TEXT", "OCR"]).nullable().default(null),
  extractionVersion: z.string().nullable().default(null),
  normalization: z.array(normalizationSchema).default([]),
  candidates: z.array(observationCandidateSchema).default([]),
  reviewRequired: z.boolean().default(false),
});
const observationFieldsSchema = z.object({
  supplierName: observedFieldSchema,
  supplierIce: observedFieldSchema,
  customerIce: observedFieldSchema,
  invoiceNumber: observedFieldSchema,
  issuedOn: observedFieldSchema,
  amountHt: observedFieldSchema,
  vatAmount: observedFieldSchema,
  amountTtc: observedFieldSchema,
  printedVatRate: observedFieldSchema,
});
const observationLabels = [
  ["supplierName", "Fournisseur"], ["supplierIce", "ICE fournisseur"],
  ["customerIce", "ICE client"], ["invoiceNumber", "Numéro de pièce"],
  ["issuedOn", "Date"], ["amountHt", "Montant HT lu"],
  ["vatAmount", "TVA lue"], ["amountTtc", "Montant TTC lu"],
  ["printedVatRate", "Taux TVA imprimé"],
] as const;
const extractionSchema = z.object({
  method: z.enum(["PDF_TEXT", "OCR", "TABULAR"]),
  version: z.string(),
  status: z.string(),
  reason: z.string().nullable(),
  pages: z.array(z.number().int().positive()),
  rows: z.array(z.number().int().positive()).default([]),
});
const tabularFieldSchema = z.object({
  value: z.string().nullable(),
  rawValue: z.string().nullable(),
  missingReason: z.string().nullable(),
  row: z.number().int().positive(),
  column: z.string(),
  extractionMethod: z.literal("TABULAR"),
  extractionVersion: z.string(),
  normalization: z.array(z.string()),
});
const tabularFieldsSchema = z.object({
  externalDocumentId: tabularFieldSchema,
  invoiceNumber: tabularFieldSchema,
  supplierName: tabularFieldSchema,
  supplierIce: tabularFieldSchema,
  issuedOn: tabularFieldSchema,
  account: tabularFieldSchema,
  printedVatRate: tabularFieldSchema,
  amountHt: tabularFieldSchema,
  vatAmount: tabularFieldSchema,
  amountTtc: tabularFieldSchema,
});
const tabularRecordSchema = z.object({
  id: z.string().uuid(),
  rowNumber: z.number().int().positive(),
  externalDocumentId: z.string().nullable(),
  status: z.enum(["COMPLETE", "PARTIAL"]),
  fields: tabularFieldsSchema,
});
const sourceSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  mediaType: z.string(),
  status: z.string(),
  createdAt: z.iso.datetime(),
  extractionStatus: z.string().nullable(),
  extractionMethod: z.string().nullable(),
  failureReason: z.string().nullable(),
  textPreview: z.string().nullable(),
  observationStatus: z.enum(["COMPLETE", "PARTIAL"]).nullable(),
  observationVersion: z.string().nullable(),
  observations: observationFieldsSchema.nullable(),
  extractions: z.array(extractionSchema),
  tabularRecords: z.array(tabularRecordSchema),
});
const sourcesSchema = z.object({ sources: z.array(sourceSchema) });
const uploadSchema = z.object({ source: z.object({ id: z.string().uuid(), status: z.string() }) });
type Batch = z.infer<typeof batchSchema>;
type Source = z.infer<typeof sourceSchema>;
type TabularField = z.infer<typeof tabularFieldSchema>;

async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(body);
    throw new Error(error.success ? error.data.error : `Erreur HTTP ${response.status}`);
  }
  return body;
}

type UploadProgress = { completed: number; total: number };

function TabularValue({ field }: { field: TabularField }) {
  return (
    <>
      <span>{field.value ?? "Non lu"}</span>
      {field.rawValue !== null && field.rawValue !== field.value && (
        <small>Brut : {field.rawValue}</small>
      )}
      {field.missingReason && <small>{field.missingReason}</small>}
    </>
  );
}

function BatchDetails({ batch }: { batch: Batch }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadSources() {
    const response = await fetch(`/api/batches/${batch.id}/sources`);
    const parsed = sourcesSchema.parse(await readJson(response));
    setSources(parsed.sources);
  }

  useEffect(() => {
    void loadSources().catch(() => setError("Impossible de charger les fichiers."));
    const timer = setInterval(() => {
      void loadSources().catch(() => setError("Impossible de charger les fichiers."));
    }, 3000);
    return () => clearInterval(timer);
  }, [batch.id]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (files.length === 0) return;
    const formElement = event.currentTarget;
    setUploading(true);
    setUploadProgress({ completed: 0, total: files.length });
    setError(null);
    const failures: string[] = [];
    for (const [index, file] of files.entries()) {
      const form = new FormData();
      form.append("file", file);
      try {
        uploadSchema.parse(await readJson(await fetch(`/api/batches/${batch.id}/sources`, {
          method: "POST", body: form,
        })));
      } catch (cause) {
        failures.push(`${file.name} : ${cause instanceof Error ? cause.message : "envoi impossible"}`);
      }
      setUploadProgress({ completed: index + 1, total: files.length });
    }
    setFiles([]);
    formElement.reset();
    await loadSources().catch(() => failures.push("La liste des fichiers n'a pas pu être actualisée."));
    setError(failures.length > 0 ? failures.join(" ") : null);
    setUploading(false);
  }

  return (
    <section aria-labelledby="sources-title" className="panel">
      <h2 id="sources-title">Fichiers du lot : {batch.name ?? batch.id}</h2>
      <p>Sélectionnez plusieurs documents en une fois. Les PDF texte sont lus directement, les scans et JPG passent par OCR, et les XLSX sont lus ligne par ligne.</p>
      {batch.status === "OPEN" ? <form onSubmit={(event) => void upload(event)}>
        <label htmlFor="source-file">Ajouter des PDF, JPG ou XLSX (15 Mo maximum par fichier)</label>
        <div className="form-row">
          <input
            id="source-file"
            type="file"
            accept="application/pdf,image/jpeg,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.pdf,.jpg,.jpeg,.xlsx"
            multiple
            onChange={(event) => {
              const selected = Array.from(event.target.files ?? []);
              setFiles(selected);
              setError(null);
              setUploadProgress(null);
            }}
            required
          />
          <button type="submit" disabled={files.length === 0 || uploading}>
            {uploading && uploadProgress
              ? `Envoi ${uploadProgress.completed}/${uploadProgress.total}…`
              : `Envoyer${files.length > 1 ? ` ${files.length} fichiers` : ""}`}
          </button>
        </div>
      </form> : <p>Ce lot est fermé : aucun nouveau document ne peut être ajouté.</p>}
      <p className="meta">{sources.length} document(s) enregistrés dans ce lot.</p>
      {uploadProgress && !uploading && (
        <p>{uploadProgress.completed}/{uploadProgress.total} envoi(s) terminé(s).</p>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {sources.length === 0 ? (
        <p>Aucun fichier dans ce lot.</p>
      ) : (
        <ul className="source-list">
          {sources.map((source) => (
            <li key={source.id}>
              <strong dir="auto" className="bidi-text">{source.filename}</strong>
              <span className="status">{source.status}</span>
              {source.failureReason && <p>{source.failureReason}</p>}
              {source.extractions.length > 0 && (
                <ul>
                  {source.extractions.map((extraction) => (
                    <li key={`${extraction.method}-${extraction.version}`}>
                      {extraction.method} {extraction.version} : {extraction.status}
                      {extraction.pages.length > 0 && ` — page(s) ${extraction.pages.join(", ")}`}
                    </li>
                  ))}
                </ul>
              )}
              {source.observations && (
                <div className="observations">
                  <p>Champs lus automatiquement, à vérifier sur la pièce source ({source.extractionMethod} / {source.observationVersion} ; {source.observationStatus}).</p>
                  <dl>
                    {observationLabels.map(([name, label]) => {
                      const observed = source.observations?.[name];
                      return (
                        <div key={name}>
                          <dt>{label}</dt>
                          <dd>
                            {observed?.value !== null && observed?.value !== undefined ? (
                              <span dir="auto" className="bidi-text">{observed.value}</span>
                            ) : `Non lu : ${observed?.missingReason ?? "motif indisponible"}`}
                            {observed?.page && (
                              <small>
                                Page {observed.page} — {observed.extractionMethod} {observed.extractionVersion}
                              </small>
                            )}
                            {observed?.rawValue && observed.rawValue !== observed.value && (
                              <small>
                                Valeur brute : <span dir="auto" className="bidi-text">{observed.rawValue}</span>
                              </small>
                            )}
                            {observed && observed.normalization.length > 0 && (
                              <small>Normalisation : {observed.normalization.join(", ")}</small>
                            )}
                            {observed && observed.value === null && observed.candidates.length > 0 && (
                              <>
                                {observed.reviewRequired && (
                                  <strong className="review-required">Revue humaine requise</strong>
                                )}
                                <ul className="candidate-list">
                                  {observed.candidates.map((candidate, candidateIndex) => (
                                    <li key={`${candidate.page}-${candidate.rawValue}-${candidateIndex}`}>
                                      <span dir="auto" className="bidi-text">{candidate.rawValue}</span>
                                      <small>
                                        Page {candidate.page} — {candidate.extractionMethod} {candidate.extractionVersion}
                                        {` — valeur normalisée ${candidate.value}`}
                                      </small>
                                    </li>
                                  ))}
                                </ul>
                              </>
                            )}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                </div>
              )}
              {source.tabularRecords.length > 0 && (
                <div className="table-scroll tabular-records">
                  <table>
                    <thead>
                      <tr>
                        <th>Ligne</th><th>ID</th><th>Numéro</th><th>Fournisseur</th>
                        <th>ICE</th><th>Date</th><th>Compte</th><th>Taux TVA</th>
                        <th>HT</th><th>TVA</th><th>TTC</th><th>État</th>
                      </tr>
                    </thead>
                    <tbody>
                      {source.tabularRecords.map((record) => (
                        <tr key={record.id}>
                          <td>{record.rowNumber}</td>
                          <td><TabularValue field={record.fields.externalDocumentId} /></td>
                          <td><TabularValue field={record.fields.invoiceNumber} /></td>
                          <td><TabularValue field={record.fields.supplierName} /></td>
                          <td><TabularValue field={record.fields.supplierIce} /></td>
                          <td><TabularValue field={record.fields.issuedOn} /></td>
                          <td><TabularValue field={record.fields.account} /></td>
                          <td className="amount"><TabularValue field={record.fields.printedVatRate} /></td>
                          <td className="amount"><TabularValue field={record.fields.amountHt} /></td>
                          <td className="amount"><TabularValue field={record.fields.vatAmount} /></td>
                          <td className="amount"><TabularValue field={record.fields.amountTtc} /></td>
                          <td>{record.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {source.textPreview && source.extractionMethod !== "TABULAR"
                && <pre dir="auto" className="bidi-text">{source.textPreview}</pre>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function App() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);

  async function loadBatches() {
    try {
      setError(null);
      const response = await fetch("/api/batches");
      const parsed = listSchema.parse(await readJson(response));
      setBatches(parsed.batches);
    } catch {
      setError("Impossible de charger les lots.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBatches();
  }, []);

  async function createBatch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const created = createSchema.parse(await readJson(response));
      setName("");
      await loadBatches();
      setSelectedBatchId(created.batch.id);
    } catch {
      setError("Impossible de créer le lot.");
    } finally {
      setSaving(false);
    }
  }

  const selectedBatch = batches.find((batch) => batch.id === selectedBatchId);

  return (
    <main className="page">
      <header>
        <p className="brand">Chiffra</p>
        <h1>Lots de documents</h1>
        <p>Créez un lot et retrouvez-le ici après rechargement de la page.</p>
      </header>

      <section aria-labelledby="create-title" className="panel">
        <h2 id="create-title">Nouveau lot</h2>
        <form onSubmit={(event) => void createBatch(event)}>
          <label htmlFor="batch-name">Nom du lot</label>
          <div className="form-row">
            <input
              id="batch-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={120}
              required
            />
            <button type="submit" disabled={saving || name.trim().length === 0}>
              {saving ? "Création…" : "Créer le lot"}
            </button>
          </div>
        </form>
      </section>

      <section aria-labelledby="list-title" className="panel">
        <h2 id="list-title">Lots enregistrés</h2>
        {error && <p role="alert" className="error">{error}</p>}
        {loading ? (
          <p>Chargement…</p>
        ) : batches.length === 0 ? (
          <p>Aucun lot enregistré.</p>
        ) : (
          <ul className="batch-list">
            {batches.map((batch) => (
              <li key={batch.id}>
                <div>
                  <button
                    type="button"
                    className="batch-select"
                    aria-pressed={selectedBatchId === batch.id}
                    onClick={() => setSelectedBatchId(batch.id)}
                  >
                    {batch.name ?? batch.id}
                  </button>
                  <small>{batch.id}</small>
                </div>
                <div className="meta">
                  <span>{batch.status}</span>
                  <time dateTime={batch.createdAt}>
                    {new Date(batch.createdAt).toLocaleString("fr-FR")}
                  </time>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {selectedBatch && (
        <>
          <BatchDetails key={selectedBatch.id} batch={selectedBatch} />
          <BankStatements
            key={`bank-${selectedBatch.id}`}
            batchId={selectedBatch.id}
            batchStatus={selectedBatch.status}
          />
          <Documents
            key={`documents-${selectedBatch.id}`}
            batchId={selectedBatch.id}
            batchStatus={selectedBatch.status}
            onCompleted={loadBatches}
          />
          <Reconciliation
            key={`reconciliation-${selectedBatch.id}`}
            batchId={selectedBatch.id}
            batchStatus={selectedBatch.status}
          />
        </>
      )}
    </main>
  );
}
