/** Minimal `@anthropic-ai/sdk` surface — see `pg.d.ts` for why it is declared here. */
declare module "@anthropic-ai/sdk" {
  export interface MessageParam {
    readonly role: "user" | "assistant";
    readonly content: string;
  }

  export interface TextBlock {
    readonly type: "text";
    readonly text: string;
  }

  export interface Message {
    readonly content: readonly TextBlock[];
  }

  export interface MessageCreateParams {
    readonly model: string;
    readonly max_tokens: number;
    readonly messages: readonly MessageParam[];
  }

  export interface Messages {
    create(params: MessageCreateParams): Promise<Message>;
  }

  export class Anthropic {
    constructor(options?: { readonly apiKey?: string });
    readonly messages: Messages;
  }

  export default Anthropic;
}
