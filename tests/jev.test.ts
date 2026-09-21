import { expect, test } from "bun:test";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { JevModel } from "../src/model";
import { config, snapshot } from "./fixtures";

test("real SDK adapter serializes terminal-outcome question and decodes Jev response (mock transport)", async () => {
  let requestBody = { state: { secondsRemaining: 0, referenceSource: "" }, questions: { direction: { criteria: { up: "" } } } };
  const provider = createTypeSafeAi({ apiKey: "test-only", fetch: Object.assign(async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.typesafe.ai/v1/systemone");
    requestBody = JSON.parse(String(init?.body));
    return Response.json({ model: "jev-latest", answers: { direction: { type: "choice", choice: "up", probabilities: { up: .86, down: .14 } } }, usage: { input_tokens: 123, output_tokens: 2 } });
  }, { preconnect() {} }) });
  const model = new JevModel(config, provider.evaluationModel("jev-latest"));
  const result = await model.decide(snapshot(), new AbortController().signal);
  expect(requestBody.state.secondsRemaining).toBe(210);
  expect(requestBody.state.referenceSource).toBe("chainlink-twap-60s");
  expect(requestBody.questions.direction.criteria.up).toContain("priceToBeat");
  expect(result.rawScores.up).toBeCloseTo(.86); expect(result.scores.up).toBeCloseTo(.68); expect(result.inputTokens).toBe(123);
});
test("Jev malformed output is rejected, without fallback to mock or one-hot score", async () => {
  const provider = createTypeSafeAi({ apiKey: "test-only", fetch: Object.assign(async () => Response.json({ answers: { direction: { type: "choice", choice: "up" } } }), { preconnect() {} }) });
  const model = new JevModel(config, provider.evaluationModel("jev-latest"));
  await expect(model.decide(snapshot(), new AbortController().signal)).rejects.toThrow();
});
