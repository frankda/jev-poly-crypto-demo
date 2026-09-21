import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "../src/config";

// One real, authenticated inference. This diagnostic contains no trading signal.
const config = readConfig();
if (!process.env.TYPESAFE_AI_API_KEY?.trim()) throw new Error("TYPESAFE_AI_API_KEY is not configured");
const started = performance.now();
try {
  const response = await experimental_evaluate({
    model: typeSafeAi.evaluationModel(config.jevModelId),
    state: { purpose: "API connectivity verification only, not a trading decision", service: "online" },
    questions: { connection: {
      type: "choice",
      instructions: { question: "Does the supplied state say the service is online or offline?" },
      criteria: { online: "The state says the service is online.", offline: "The state says the service is offline." },
    } },
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(15000),
  });
  const result = {
    ok: true, verifiedAt: new Date().toISOString(),
    provider: "TypeSafe AI", requestedModel: config.jevModelId, responseModel: response.response.modelId,
    answer: response.answers.connection, latencyMs: Math.round(performance.now() - started),
    usage: response.usage,
  };
  if (config.ledger === "sqlite") {
    mkdirSync(config.dataDir, { recursive: true });
    await Bun.write(resolve(config.dataDir, "jev-connectivity.json"), JSON.stringify(result, null, 2));
  }
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  const secret = process.env.TYPESAFE_AI_API_KEY;
  const rawMessage = error instanceof Error ? error.message : "Unknown request failure";
  const message = secret ? rawMessage.split(secret).join("[redacted]") : rawMessage;
  console.error(JSON.stringify({ ok: false, message: message.slice(0, 400) }));
  process.exitCode = 1;
}
