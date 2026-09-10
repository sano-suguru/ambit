import path from "node:path";

/**
 * GitHub Actions workflow-command escaping and path handling, shared by every
 * command that emits annotations.
 *
 * One implementation, because `check` and `diff` annotate the same files in
 * the same run: two escapings that drifted apart would show up as one command
 * annotating a line the other could not.
 */

/** Workflow-command escaping for the message body. */
export function githubData(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

/** Workflow-command escaping for a property value, where `:` and `,` also terminate. */
export function githubProperty(value: string): string {
  return githubData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

/**
 * A `location.file` — relative to the directory that was checked — re-expressed
 * relative to the working directory, which is what an annotation is resolved
 * against.
 */
export function workspacePath(rootDir: string, file: string): string {
  return path.relative(process.cwd(), path.resolve(rootDir, file)).split(path.sep).join("/");
}

/**
 * One workflow command: `::<severity> file=...,line=...,col=...,title=...::<body>`.
 *
 * The body is folded onto one line with `%0A`, so an annotation carrying a
 * call path stays self-sufficient — a reader on the diff sees every hop
 * without opening the job log (DESIGN.md §5.1).
 */
export function githubAnnotation(annotation: {
  readonly severity: string;
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly title: string;
  readonly body: readonly string[];
}): string {
  const properties = [
    `file=${githubProperty(annotation.file)}`,
    `line=${annotation.line}`,
    `col=${annotation.col}`,
    `title=${githubProperty(annotation.title)}`,
  ].join(",");
  return `::${annotation.severity} ${properties}::${githubData(annotation.body.join("\n"))}\n`;
}
