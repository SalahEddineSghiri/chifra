import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";

const batchSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  status: z.string(),
  createdAt: z.iso.datetime(),
});
const listSchema = z.object({ batches: z.array(batchSchema) });
const createSchema = z.object({ batch: batchSchema });
const sourceSchema = z.object({
  id: z.string().uuid(),
  filename: z.string(),
  status: z.string(),
  createdAt: z.iso.datetime(),
  extractionStatus: z.string().nullable(),
  extractionMethod: z.string().nullable(),
  failureReason: z.string().nullable(),
  textPreview: z.string().nullable(),
});
const sourcesSchema = z.object({ sources: z.array(sourceSchema) });
const uploadSchema = z.object({ source: z.object({ id: z.string().uuid(), status: z.string() }) });
type Batch = z.infer<typeof batchSchema>;
type Source = z.infer<typeof sourceSchema>;

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);
  return response.json();
}

function BatchDetails({ batch }: { batch: Batch }) {
  const [sources, setSources] = useState<Source[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadSources() {
    const response = await fetch(`/api/batches/${batch.id}/sources`);
    const parsed = sourcesSchema.parse(await readJson(response));
    setSources(parsed.sources);
    setError(null);
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
    if (!file) return;
    const formElement = event.currentTarget;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      uploadSchema.parse(await readJson(await fetch(`/api/batches/${batch.id}/sources`, {
        method: "POST", body: form,
      })));
      setFile(null);
      formElement.reset();
      await loadSources();
    } catch {
      setError("Envoi impossible. Vérifiez le PDF, sa taille et les doublons.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <section aria-labelledby="sources-title" className="panel">
      <h2 id="sources-title">Fichiers du lot : {batch.name ?? batch.id}</h2>
      <p>PDF texte uniquement pour cette étape. Un scan sans texte porte un motif explicite.</p>
      <form onSubmit={(event) => void upload(event)}>
        <label htmlFor="source-file">Ajouter un PDF (15 Mo maximum)</label>
        <div className="form-row">
          <input
            id="source-file"
            type="file"
            accept="application/pdf,.pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
          <button type="submit" disabled={!file || uploading}>
            {uploading ? "Envoi…" : "Envoyer"}
          </button>
        </div>
      </form>
      {error && <p role="alert" className="error">{error}</p>}
      {sources.length === 0 ? (
        <p>Aucun fichier dans ce lot.</p>
      ) : (
        <ul className="source-list">
          {sources.map((source) => (
            <li key={source.id}>
              <strong>{source.filename}</strong>
              <span className="status">{source.status}</span>
              {source.failureReason && <p>{source.failureReason}</p>}
              {source.textPreview && <pre>{source.textPreview}</pre>}
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
      {selectedBatch && <BatchDetails key={selectedBatch.id} batch={selectedBatch} />}
    </main>
  );
}
