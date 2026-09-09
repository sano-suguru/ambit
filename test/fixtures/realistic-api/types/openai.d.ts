/** Minimal `openai` surface — see `pg.d.ts` for why it is declared here. */
declare module "openai" {
  export interface ChatMessage {
    readonly role: "system" | "user" | "assistant";
    readonly content: string;
  }

  export interface ChatCompletion {
    readonly choices: readonly {
      readonly message: { readonly content: string | null };
    }[];
  }

  export interface ChatCompletionParams {
    readonly model: string;
    readonly messages: readonly ChatMessage[];
  }

  export interface ChatCompletions {
    create(params: ChatCompletionParams): Promise<ChatCompletion>;
  }

  export interface Chat {
    readonly completions: ChatCompletions;
  }

  export class OpenAI {
    constructor(options?: { readonly apiKey?: string });
    readonly chat: Chat;
  }

  export default OpenAI;
}
