import { ChatOpenAI } from "@langchain/openai";

function openRouterModel(modelName: string, temperature: number) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");
  return new ChatOpenAI({
    modelName,
    temperature,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: { "HTTP-Referer": "https://agents.local" },
    },
    apiKey,
  });
}

export function createChatModel() {
  return openRouterModel("openai/gpt-4o-mini", 0.3);
}

export function createCompactionModel() {
  return openRouterModel("anthropic/claude-haiku-4-5", 0);
}
