import { Anthropic } from "@anthropic-ai/sdk";

export const anthropic = new Anthropic({ apiKey: "sk-ant-fixture" });

/** @effects llm */
export async function draftReply(prompt: string): Promise<string> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 256,
    messages: [{ role: "user", content: prompt }],
  });
  return message.content[0]?.text ?? "";
}

/** @effects llm */
export async function classifyRisk(description: string): Promise<string> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 16,
    messages: [{ role: "user", content: `Classify: ${description}` }],
  });
  return message.content[0]?.text ?? "unknown";
}
