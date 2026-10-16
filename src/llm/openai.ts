import OpenAI from "openai";
import * as dotenv from "dotenv";
dotenv.config();

export class LLMAdapter {
  private client: OpenAI;
  private modelName: string;

  constructor(modelName: string = "gpt-4o") {
    this.client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || process.env.LLM_API_KEY,
      baseURL: process.env.LLM_BASE_URL // Optional for custom gateways/groq/deepseek/etc.
    });
    this.modelName = modelName;
  }

  async chat(messages: Array<{ role: "system" | "user" | "assistant"; content: string }>, tools?: any[]) {
    const response = await this.client.chat.completions.create({
      model: this.modelName,
      messages: messages as any,
      tools: tools,
      tool_choice: tools ? "auto" : undefined,
    });

    return response.choices[0].message;
  }
}