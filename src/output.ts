export function fail(message: string): number {
  process.stderr.write(`claude-launcher: ${message}\n`);
  return 1;
}

export function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

// The one thing meant to be captured, as in eval "$(claude-launcher add deepseek)".
export function result(line: string): void {
  process.stdout.write(`${line}\n`);
}
