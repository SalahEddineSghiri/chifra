import { createHash } from "node:crypto";
import OpenAI, { AzureOpenAI } from "openai";
import type { Pool } from "pg";
import { z } from "zod";

export const PLAN_PROMPT_VERSION = "agent-plan-v1";
export const EXPLANATION_PROMPT_VERSION = "agent-explanation-v1";
export const LLM_SCHEMA_VERSION = "agent-json-v1";

export const agentActionSchema = z.enum([
  "READ_RECONCILIATION",
  "READ_AUDIT",
  "ESCALATE_HUMAN",
  "EXPLAIN",
]);

export const agentPlanSchema = z.strictObject({
  actions: z.array(agentActionSchema).min(1).max(4),
  reason: z.string().trim().min(1).max(500),
});

const proseSchema = z.string().trim().min(1).max(700).refine(
  (value) => !/\p{N}/u.test(value),
  "Le texte explicatif ne doit contenir aucun nombre libre.",
);

export const agentExplanationSchema = z.strictObject({
  overview: proseSchema,
  findings: z.array(z.strictObject({
    evidenceId: z.string().trim().min(1).max(100),
    explanation: proseSchema,
    recommendedAction: proseSchema,
  })).min(1).max(20),
  limitations: z.array(proseSchema).max(10),
});

export type AgentPlan = z.infer<typeof agentPlanSchema>;
export type AgentExplanation = z.infer<typeof agentExplanationSchema>;
export type LlmTokenUsage = { input: number | null; output: number | null };
export type LlmInvocation<T> = {
  output: T;
  task: "COMPLEX_PLAN" | "EVIDENCE_EXPLANATION";
  model: string;
  selectionReason: string;
  cached: boolean;
  durationMs: number;
  tokenUsage: LlmTokenUsage;
};

export type PlanInput = {
  batchStatus: string;
  sourceCount: number;
  unreadableSourceCount: number;
  reviewDocumentCount: number;
  reconciliationReviewCount: number;
  auditAnomalyCount: number;
  availableTools: string[];
};

export type ExplanationEvidence = {
  id: string;
  kind: "RECONCILIATION" | "AUDIT" | "INGESTION";
  status: string;
  message: string;
  proofId: string | null;
};

export interface AgentLlm {
  plan(input: PlanInput): Promise<LlmInvocation<AgentPlan>>;
  explain(input: { evidence: ExplanationEvidence[] }): Promise<LlmInvocation<AgentExplanation>>;
}

export class LlmConfigurationError extends Error {}
export class LlmResponseError extends Error {}

export function completeExplanation(
  evidence: ExplanationEvidence[],
  explanation: AgentExplanation,
): AgentExplanation {
  const evidenceIds = new Set(evidence.map((item) => item.id));
  if (explanation.findings.some((item) => !evidenceIds.has(item.evidenceId))) {
    throw new LlmResponseError("Une explication cite une preuve inexistante.");
  }
  const byEvidence = new Map<string, AgentExplanation["findings"][number]>();
  for (const finding of explanation.findings) {
    if (!byEvidence.has(finding.evidenceId)) byEvidence.set(finding.evidenceId, finding);
  }
  const missing = evidence.filter((item) => !byEvidence.has(item.id));
  const findings = evidence.map((item) => byEvidence.get(item.id) ?? {
    evidenceId: item.id,
    explanation: "Cette preuve déterministe reste disponible sans explication générée validée.",
    recommendedAction: "Consulter la preuve source avant toute décision.",
  });
  return {
    ...explanation,
    findings,
    limitations: missing.length === 0 ? explanation.limitations : [...new Set([
        ...explanation.limitations,
        "Une explication manquante a été remplacée par un constat système explicite.",
      ])].slice(-10),
  };
}

type CacheRow = { output_payload: unknown };
type RuntimeConfig = {
  timeoutMs: number;
  maxCallsPerRun: number;
  complex: { baseURL: string; apiKey: string; model: string };
  routine: { endpoint: string; apiKey: string; apiVersion: string; deployment: string; maxTokens: number };
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new LlmConfigurationError(`Configuration LLM manquante : ${name}.`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new LlmConfigurationError(`${name} doit être un entier positif.`);
  }
  return parsed;
}

export function loadLlmConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  return {
    timeoutMs: positiveInteger(env.LLM_TIMEOUT_MS, 45_000, "LLM_TIMEOUT_MS"),
    maxCallsPerRun: positiveInteger(env.LLM_MAX_CALLS_PER_RUN, 2, "LLM_MAX_CALLS_PER_RUN"),
    complex: {
      baseURL: required(env, "LLM_URL"),
      apiKey: required(env, "LLM_API_KEY"),
      model: required(env, "LLM_MODEL"),
    },
    routine: {
      endpoint: required(env, "AZURE_OPENAI_ENDPOINT"),
      apiKey: required(env, "AZURE_OPENAI_API_KEY"),
      apiVersion: required(env, "AZURE_OPENAI_API_VERSION"),
      deployment: required(env, "AZURE_OPENAI_DEPLOYMENT_NAME"),
      maxTokens: positiveInteger(env.AZURE_OPENAI_MAX_TOKENS, 1_200, "AZURE_OPENAI_MAX_TOKENS"),
    },
  };
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function parseJson(text: string): unknown {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new LlmResponseError("Réponse LLM non conforme au format JSON attendu.");
  }
}

function cacheKey(task: string, model: string, promptVersion: string, input: unknown): string {
  return createHash("sha256").update(stable({ task, model, promptVersion, input })).digest("hex");
}

async function fromCache<T>(
  pool: Pool,
  key: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  const result = await pool.query<CacheRow>(
    `UPDATE llm_response_cache SET last_used_at = now()
      WHERE cache_key = $1 RETURNING output_payload`,
    [key],
  );
  const row = result.rows[0];
  if (!row) return null;
  const parsed = schema.safeParse(row.output_payload);
  return parsed.success ? parsed.data : null;
}

async function saveCache(
  pool: Pool,
  key: string,
  task: string,
  model: string,
  promptVersion: string,
  output: unknown,
) {
  await pool.query(
    `INSERT INTO llm_response_cache (
       cache_key, task, model, prompt_version, schema_version, output_payload
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (cache_key) DO UPDATE
       SET last_used_at = now(), output_payload = EXCLUDED.output_payload`,
    [key, task, model, promptVersion, LLM_SCHEMA_VERSION, JSON.stringify(output)],
  );
}

export function createAzureAgentLlm(pool: Pool, env: NodeJS.ProcessEnv = process.env): AgentLlm {
  const config = loadLlmConfig(env);
  if (config.maxCallsPerRun < 2) {
    throw new LlmConfigurationError("LLM_MAX_CALLS_PER_RUN doit autoriser les deux tâches du graphe.");
  }
  const complexClient = new OpenAI({
    apiKey: config.complex.apiKey,
    baseURL: config.complex.baseURL,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });
  const routineClient = new AzureOpenAI({
    apiKey: config.routine.apiKey,
    endpoint: config.routine.endpoint,
    apiVersion: config.routine.apiVersion,
    deployment: config.routine.deployment,
    timeout: config.timeoutMs,
    maxRetries: 0,
  });
  let actualCalls = 0;

  function consumeCallBudget() {
    actualCalls += 1;
    if (actualCalls > config.maxCallsPerRun) {
      throw new LlmResponseError("Budget d'appels LLM dépassé pour cette tentative.");
    }
  }

  return {
    async plan(input) {
      const task = "COMPLEX_PLAN" as const;
      const model = config.complex.model;
      const selectionReason = "Planification multietape réservée au modèle complexe.";
      const key = cacheKey(task, model, PLAN_PROMPT_VERSION, input);
      const cached = await fromCache(pool, key, agentPlanSchema);
      if (cached) return { output: cached, task, model, selectionReason, cached: true, durationMs: 0, tokenUsage: { input: null, output: null } };
      consumeCallBudget();
      const started = Date.now();
      const response = await complexClient.responses.create({
        model,
        input: [
          { role: "system", content: "Tu planifies une analyse comptable. Choisis uniquement parmi les actions autorisées. Tu ne calcules aucun montant. Réponds uniquement avec ce JSON exact : {\"actions\":[\"READ_RECONCILIATION\"|\"READ_AUDIT\"|\"ESCALATE_HUMAN\"|\"EXPLAIN\"],\"reason\":\"texte\"}." },
          { role: "user", content: JSON.stringify(input) },
        ],
        max_output_tokens: 600,
      });
      const parsed = agentPlanSchema.safeParse(parseJson(response.output_text));
      if (!parsed.success) throw new LlmResponseError("Plan LLM invalide après validation stricte.");
      await saveCache(pool, key, task, model, PLAN_PROMPT_VERSION, parsed.data);
      return {
        output: parsed.data, task, model, selectionReason, cached: false,
        durationMs: Date.now() - started,
        tokenUsage: { input: response.usage?.input_tokens ?? null, output: response.usage?.output_tokens ?? null },
      };
    },
    async explain(input) {
      const task = "EVIDENCE_EXPLANATION" as const;
      const model = config.routine.deployment;
      const selectionReason = "Explication structurée répétitive à partir de preuves déjà calculées.";
      const key = cacheKey(task, model, EXPLANATION_PROMPT_VERSION, input);
      const cached = await fromCache(pool, key, agentExplanationSchema);
      if (cached) return {
        output: completeExplanation(input.evidence, cached),
        task, model, selectionReason, cached: true, durationMs: 0,
        tokenUsage: { input: null, output: null },
      };
      consumeCallBudget();
      const started = Date.now();
      const response = await routineClient.chat.completions.create({
        model,
        messages: [
          { role: "system", content: "Explique les preuves fournies sans ajouter de nombre, montant, taux ni fait. Chaque constat doit citer exactement un evidenceId fourni. Aucun texte ne doit contenir de chiffre. Réponds uniquement avec ce JSON exact : {\"overview\":\"texte\",\"findings\":[{\"evidenceId\":\"identifiant fourni\",\"explanation\":\"texte\",\"recommendedAction\":\"texte\"}],\"limitations\":[\"texte\"]}." },
          { role: "user", content: JSON.stringify(input) },
        ],
        response_format: { type: "json_object" },
        max_tokens: Math.min(config.routine.maxTokens, 1_200),
        temperature: 0,
      });
      const content = response.choices[0]?.message.content;
      if (!content) throw new LlmResponseError("Réponse GPT-4.1 vide.");
      const parsed = agentExplanationSchema.safeParse(parseJson(content));
      if (!parsed.success) throw new LlmResponseError("Explication LLM invalide après validation stricte.");
      const completed = completeExplanation(input.evidence, parsed.data);
      await saveCache(pool, key, task, model, EXPLANATION_PROMPT_VERSION, completed);
      return {
        output: completed, task, model, selectionReason, cached: false,
        durationMs: Date.now() - started,
        tokenUsage: {
          input: response.usage?.prompt_tokens ?? null,
          output: response.usage?.completion_tokens ?? null,
        },
      };
    },
  };
}
