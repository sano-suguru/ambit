import { OpenAI } from "openai";

export const openai = new OpenAI({ apiKey: "sk-fixture" });

/** @effects llm */
export async function summarize(text: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: text }],
  });
  return completion.choices[0]?.message.content ?? "";
}
