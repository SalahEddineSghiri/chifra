import { useEffect, useState } from "react";
import { z } from "zod";

const planSchema = z.object({
  actions: z.array(z.string()),
  reason: z.string(),
});
const explanationSchema = z.object({
  overview: z.string(),
  findings: z.array(z.object({
    evidenceId: z.string(),
    explanation: z.string(),
    recommendedAction: z.string(),
  })),
  limitations: z.array(z.string()),
});
const eventSchema = z.object({
  id: z.string().uuid(),
  sequence: z.number().int().positive(),
  role: z.string(),
  eventType: z.string(),
  task: z.string(),
  model: z.string().nullable(),
  selectionReason: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.iso.datetime(),
});
const runSchema = z.object({
  id: z.string().uuid(),
  graphVersion: z.string(),
  status: z.enum(["PENDING", "PROCESSING", "WAITING_HUMAN", "COMPLETED", "FAILED"]),
  currentStep: z.string().nullable(),
  failureReason: z.string().nullable(),
  plan: planSchema.nullable(),
  explanation: explanationSchema.nullable(),
  requiresHuman: z.boolean(),
  humanReasons: z.array(z.string()),
  events: z.array(eventSchema),
});
const responseSchema = z.object({ batchStatus: z.string(), run: runSchema.nullable() });
type Run = z.infer<typeof runSchema>;

async function readJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = z.object({ error: z.string() }).safeParse(body);
    throw new Error(parsed.success ? parsed.data.error : `Erreur HTTP ${response.status}`);
  }
  return body;
}

export function AgentAnalysis({ batchId, batchStatus }: { batchId: string; batchStatus: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const parsed = responseSchema.parse(await readJson(
      await fetch(`/api/batches/${batchId}/agent-analysis`),
    ));
    setRun(parsed.run);
  }

  useEffect(() => {
    void load().catch(() => setError("Impossible de charger l'analyse agentique."));
    if (run && !["PENDING", "PROCESSING"].includes(run.status)) return;
    const timer = setInterval(() => {
      void load().catch(() => setError("Impossible de charger l'analyse agentique."));
    }, 2000);
    return () => clearInterval(timer);
  }, [batchId, run?.status]);

  async function start() {
    setRunning(true);
    setError(null);
    try {
      const parsed = responseSchema.parse(await readJson(await fetch(
        `/api/batches/${batchId}/agent-analysis`, { method: "POST" },
      )));
      setRun(parsed.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Analyse agentique impossible.");
    } finally {
      setRunning(false);
    }
  }

  return (
    <section aria-labelledby="agent-title" className="panel">
      <h2 id="agent-title">Analyse agentique</h2>
      <p>L'agent lit les preuves du rapprochement et de l'audit. Les calculs restent exécutés par les moteurs déterministes.</p>
      {batchStatus !== "COMPLETED" && <p>Cette analyse devient disponible après consolidation.</p>}
      {batchStatus === "COMPLETED" && run === null && (
        <button type="button" onClick={() => void start()} disabled={running}>
          {running ? "Démarrage…" : "Analyser les preuves"}
        </button>
      )}
      {run && ["PENDING", "PROCESSING"].includes(run.status) && (
        <p>Orchestration en cours dans le worker : {run.currentStep ?? run.status}.</p>
      )}
      {run?.status === "FAILED" && (
        <>
          <p role="alert" className="error">{run.failureReason ?? "L'analyse agentique a échoué."}</p>
          <button type="button" onClick={() => void start()} disabled={running}>
            {running ? "Relance…" : "Relancer l'analyse"}
          </button>
        </>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {run?.plan && (
        <>
          <p className="meta-line">Graphe {run.graphVersion} — exécution {run.id}</p>
          <h3>Plan validé</h3>
          <p>{run.plan.reason}</p>
          <ul className="compact-list">{run.plan.actions.map((action) => <li key={action}>{action}</li>)}</ul>
        </>
      )}
      {run?.requiresHuman && (
        <div className="review-box" role="status">
          <strong>Revue humaine requise</strong>
          <ul>{run.humanReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
          <p>La décision humaine sera ajoutée dans l'étape de revue dédiée.</p>
        </div>
      )}
      {run?.explanation && (
        <>
          <h3>Explication reliée aux preuves</h3>
          <p>{run.explanation.overview}</p>
          <ul className="source-list">
            {run.explanation.findings.map((finding) => (
              <li key={`${finding.evidenceId}-${finding.explanation}`}>
                <strong>{finding.evidenceId}</strong>
                <p>{finding.explanation}</p>
                <small>Action proposée : {finding.recommendedAction}</small>
              </li>
            ))}
          </ul>
          {run.explanation.limitations.length > 0 && (
            <><h3>Limites</h3><ul>{run.explanation.limitations.map((item) => <li key={item}>{item}</li>)}</ul></>
          )}
        </>
      )}
      {run && run.events.length > 0 && (
        <details>
          <summary>Trace des outils et modèles</summary>
          <ol className="compact-list">
            {run.events.map((event) => (
              <li key={event.id}>
                {event.role} — {event.task} — {event.eventType}
                {event.model && <small className="cell-detail">Modèle : {event.model}</small>}
                {event.selectionReason && <small className="cell-detail">{event.selectionReason}</small>}
                {event.durationMs !== null && <small className="cell-detail">Durée : {event.durationMs} ms</small>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
