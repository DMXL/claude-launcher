import { readSync } from "node:fs";

export class Interrupted extends Error {
  constructor() {
    super("cancelled");
    this.name = "Interrupted";
  }
}

function readOneLine(hidden: boolean): string {
  const terminal = process.stdin.isTTY === true;
  const buffer = Buffer.alloc(1);
  let value = "";

  if (hidden && terminal) process.stdin.setRawMode(true);

  try {
    for (;;) {
      let read: number;
      try {
        read = readSync(0, buffer, 0, 1, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
        throw error;
      }
      if (read === 0) break;

      // Keys and menu answers are ASCII, so a byte at a time needs no decoder state.
      const character = buffer.toString("latin1");
      if (character === "\n" || character === "\r") break;
      if (character === "") throw new Interrupted();
      // Only raw mode needs to edit: a cooked terminal handles backspace itself.
      if (hidden && (character === "" || character === "\b")) {
        value = value.slice(0, -1);
        continue;
      }
      value += character;
    }
  } finally {
    if (hidden && terminal) process.stdin.setRawMode(false);
  }

  return value;
}

export function promptLine(question: string): string {
  process.stderr.write(question);
  return readOneLine(false);
}

export function promptHidden(question: string): string {
  process.stderr.write(question);
  try {
    return readOneLine(true);
  } finally {
    process.stderr.write("\n");
  }
}
