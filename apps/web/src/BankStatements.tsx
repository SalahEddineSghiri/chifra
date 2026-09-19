import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

const classificationSchema = z.enum([
  "PURCHASE_CANDIDATE", "SALARY", "BANK_FEE", "CLIENT_RECEIPT", "OTHER",
]);
const rawValuesSchema = z.object({
  date: z.string(),
  libelle: z.string(),
  debit_mad: z.string(),
  credit_mad: z.string(),
  solde_mad: z.string(),
});
const lineSchema = z.object({
  id: z.string().uuid(),
  lineNumber: z.number().int().positive(),
  bookedOn: z.iso.date(),
  label: z.string(),
  debitMad: z.string(),
  creditMad: z.string(),
  balanceMad: z.string(),
  classification: classificationSchema,
  balanceConsistent: z.boolean().nullable(),
  rawValues: rawValuesSchema,
});
const statementSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  parserVersion: z.string(),
  rowCount: z.number().int().positive(),
  createdAt: z.iso.datetime(),
  lines: z.array(lineSchema),
});
const listSchema = z.object({ statements: z.array(statementSchema) });
const createSchema = z.object({
  statement: z.object({
    id: z.string().uuid(),
    filename: z.string(),
    parserVersion: z.string(),
    rowCount: z.number().int().positive(),
  }),
});
type Statement = z.infer<typeof statementSchema>;

const classificationLabels = {
  PURCHASE_CANDIDATE: "Paiement fournisseur possible",
  SALARY: "Salaire exclu du rapprochement achats",
  BANK_FEE: "Frais bancaire exclu",
  CLIENT_RECEIPT: "Règlement client exclu",
  OTHER: "Nature à vérifier",
} as const;

async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `Erreur HTTP ${response.status}`);
  }
  return body;
}

export function BankStatements({ batchId }: { batchId: string }) {
  const [statements, setStatements] = useState<Statement[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const response = await fetch(`/api/batches/${batchId}/bank-statements`);
    setStatements(listSchema.parse(await readJson(response)).statements);
  }

  useEffect(() => {
    void load().catch(() => setError("Impossible de charger les relevés bancaires."));
  }, [batchId]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    const formElement = event.currentTarget;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      createSchema.parse(await readJson(await fetch(`/api/batches/${batchId}/bank-statements`, {
        method: "POST", body: form,
      })));
      setFile(null);
      formElement.reset();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Import du relevé impossible.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section aria-labelledby="bank-title" className="panel">
      <h2 id="bank-title">Relevés bancaires</h2>
      <p>Importez le CSV original. Les montants restent exacts en MAD et chaque ligne conserve ses valeurs brutes.</p>
      <form onSubmit={(event) => void upload(event)}>
        <label htmlFor="bank-file">Ajouter un relevé CSV (2 Mo maximum)</label>
        <div className="form-row">
          <input
            id="bank-file"
            type="file"
            accept="text/csv,.csv"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
          <button type="submit" disabled={!file || uploading}>
            {uploading ? "Import…" : "Importer"}
          </button>
        </div>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {statements.length === 0 ? (
        <p>Aucun relevé dans ce lot.</p>
      ) : statements.map((statement) => (
        <article className="bank-statement" key={statement.id}>
          <h3>{statement.filename}</h3>
          <p>{statement.rowCount} ligne(s) — parseur {statement.parserVersion}</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Libellé</th><th>Débit</th><th>Crédit</th>
                  <th>Solde</th><th>Nature</th><th>Contrôle du solde</th>
                </tr>
              </thead>
              <tbody>
                {statement.lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.bookedOn}</td>
                    <td>{line.label}</td>
                    <td className="amount">
                      {line.debitMad}
                      {line.rawValues.debit_mad !== line.debitMad
                        && <small>Brut : {line.rawValues.debit_mad}</small>}
                    </td>
                    <td className="amount">
                      {line.creditMad}
                      {line.rawValues.credit_mad !== line.creditMad
                        && <small>Brut : {line.rawValues.credit_mad}</small>}
                    </td>
                    <td className="amount">
                      {line.balanceMad}
                      {line.rawValues.solde_mad !== line.balanceMad
                        && <small>Brut : {line.rawValues.solde_mad}</small>}
                    </td>
                    <td>{classificationLabels[line.classification]}</td>
                    <td>
                      {line.balanceConsistent === null
                        ? "Point de départ"
                        : line.balanceConsistent ? "Cohérent" : "Écart détecté"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      ))}
    </section>
  );
}
