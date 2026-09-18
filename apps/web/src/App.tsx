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
type Batch = z.infer<typeof batchSchema>;

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Erreur HTTP ${response.status}`);
  return response.json();
}

export function App() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      createSchema.parse(await readJson(response));
      setName("");
      await loadBatches();
    } catch {
      setError("Impossible de créer le lot.");
    } finally {
      setSaving(false);
    }
  }

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
                  <strong>{batch.name ?? batch.id}</strong>
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
    </main>
  );
}
