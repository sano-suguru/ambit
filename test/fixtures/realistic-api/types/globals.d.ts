/**
 * The two globals this project uses. Declared here rather than pulled from
 * `@types/node` or `lib.dom` so the fixture resolves identically wherever it
 * is copied — the tsconfig sets `types: []` and `lib: ["ES2023"]`.
 */

interface RequestInitLike {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

interface FetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

declare function fetch(input: string, init?: RequestInitLike): Promise<FetchResponse>;
