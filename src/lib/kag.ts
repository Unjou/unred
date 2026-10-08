import { codeToString, convert, detect, stringToCode } from "encoding-japanese";

export type ScriptLineKind = "dialogue" | "command" | "comment" | "blank";
export type ScriptEngine = "KAG" | "KRKRZ";
export type ScriptEncoding = "UTF-8" | "Shift-JIS";

export interface ScriptLine {
  id: string;
  lineNumber: number;
  original: string;
  source: string;
  target: string | null;
  kind: ScriptLineKind;
  speaker: string | null;
}

export interface ScriptDocument {
  id: string;
  fileName: string;
  engine: ScriptEngine;
  encoding: ScriptEncoding;
  lines: ScriptLine[];
  updatedAt: number;
  lineEnding?: "\n" | "\r\n" | "\r";
  trailingNewline?: boolean;
  hasBom?: boolean;
}

export interface LineAnalysis {
  status: "untranslated" | "ready" | "warning" | "error";
  issues: string[];
  charCount: number;
}

export interface DecodedKagText {
  text: string;
  encoding: ScriptEncoding;
  hasBom: boolean;
}

const PAIRED_TAGS = new Set(["b", "i", "u", "ruby", "font", "color", "size", "sup", "sub", "link"]);

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `script-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getKind(value: string): ScriptLineKind {
  const trimmed = value.trim();
  if (!trimmed) return "blank";
  if (/^(?:;|\/\/)/.test(trimmed)) return "comment";
  if (/^[@*]/.test(trimmed) || /^\[[\w!?/:-]+(?:\s+[^\]]*)?\]$/.test(trimmed)) {
    return "command";
  }
  return "dialogue";
}

function detectSpeaker(value: string): string | null {
  const match = value.match(/^\s*#([^\s[]+)/);
  return match?.[1] ?? null;
}

export function parseKagScript(text: string, fileName: string): ScriptDocument {
  const detectedEnding = text.match(/\r\n|\n|\r/)?.[0];
  const lineEnding: "\n" | "\r\n" | "\r" =
    detectedEnding === "\r\n" ? "\r\n" : detectedEnding === "\r" ? "\r" : "\n";
  const trailingNewline = /(?:\r\n|\n|\r)$/.test(text);
  const sourceLines = text.split(/\r\n|\n|\r/);
  if (trailingNewline) sourceLines.pop();

  const lines = sourceLines.map((original, index): ScriptLine => ({
    id: `${index + 1}`,
    lineNumber: index + 1,
    original,
    source: original,
    target: null,
    kind: getKind(original),
    speaker: detectSpeaker(original),
  }));

  return {
    id: makeId(),
    fileName,
    engine: /krkrz/i.test(fileName) ? "KRKRZ" : "KAG",
    encoding: "UTF-8",
    lines,
    updatedAt: Date.now(),
    lineEnding,
    trailingNewline,
  };
}

export function decodeKagBytes(bytes: ArrayBuffer, encoding?: ScriptEncoding): DecodedKagText {
  const data = new Uint8Array(bytes);
  const hasBom = data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf;
  if (data.length === 0) return { text: "", encoding: encoding ?? "UTF-8", hasBom: false };
  const detected = encoding === "Shift-JIS"
    ? "SJIS"
    : encoding === "UTF-8"
      ? "UTF8"
      : detect(data, ["UTF8", "SJIS"]);

  if (detected === "UTF8") {
    try {
      return {
        text: new TextDecoder("utf-8", { fatal: true }).decode(data),
        encoding: "UTF-8",
        hasBom,
      };
    } catch {
      throw new Error("This file could not be decoded as UTF-8.");
    }
  }
  if (detected === "SJIS") {
    try {
      const unicode = convert(data, { to: "UNICODE", from: "SJIS", type: "array", fallback: "error" });
      return { text: codeToString(unicode), encoding: "Shift-JIS", hasBom: false };
    } catch {
      throw new Error("This file could not be decoded as Shift-JIS / CP932.");
    }
  }
  throw new Error("The script encoding could not be identified as UTF-8 or Shift-JIS.");
}

export function encodeKagText(text: string, encoding: ScriptEncoding, hasBom = false): Blob {
  if (encoding === "UTF-8") {
    const body = new TextEncoder().encode(text);
    const output = hasBom
      ? new Uint8Array([0xef, 0xbb, 0xbf, ...body])
      : body;
    return new Blob([output.buffer as ArrayBuffer], { type: "text/plain;charset=utf-8" });
  }

  try {
    const encoded = convert(stringToCode(text), {
      to: "SJIS",
      from: "UNICODE",
      type: "array",
      fallback: "error",
    });
    return new Blob([new Uint8Array(encoded).buffer as ArrayBuffer], {
      type: "text/plain;charset=shift_jis",
    });
  } catch {
    throw new Error("Some translated characters cannot be represented in Shift-JIS. Choose UTF-8 or replace those characters.");
  }
}

export function stringifyKagScript(document: ScriptDocument): string {
  const rows = document.lines.map((line) => {
    if (line.kind !== "dialogue" || line.target === null) return line.original;
    return line.target;
  });
  const contents = rows.join(document.lineEnding ?? "\n");
  return document.trailingNewline ? `${contents}${document.lineEnding ?? "\n"}` : contents;
}

export function createUnifiedPatch(
  originalText: string,
  translatedText: string,
  fileName: string,
): string {
  const splitLines = (text: string) => text.replace(/\r\n|\r/g, "\n").split("\n");
  const before = splitLines(originalText);
  const after = splitLines(translatedText);
  if (before.length !== after.length) {
    return [
      `--- a/${fileName}`,
      `+++ b/${fileName}`,
      `@@ -1,${before.length} +1,${after.length} @@`,
      ...before.map((line) => `-${line}`),
      ...after.map((line) => `+${line}`),
      "",
    ].join("\n");
  }

  const changed = before.flatMap((line, index) => line === after[index] ? [] : [index]);
  if (changed.length === 0) return `--- a/${fileName}\n+++ b/${fileName}\n`;

  const ranges: Array<[number, number]> = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(before.length - 1, index + 3);
    const previous = ranges.at(-1);
    if (previous && start <= previous[1] + 1) previous[1] = end;
    else ranges.push([start, end]);
  }

  const output = [`--- a/${fileName}`, `+++ b/${fileName}`];
  for (const [start, end] of ranges) {
    const rowCount = end - start + 1;
    output.push(`@@ -${start + 1},${rowCount} +${start + 1},${rowCount} @@`);
    for (let index = start; index <= end; index += 1) {
      if (before[index] === after[index]) {
        output.push(` ${before[index]}`);
      } else {
        output.push(`-${before[index]}`, `+${after[index]}`);
      }
    }
  }
  return `${output.join("\n")}\n`;
}

function tagsIn(value: string): string[] {
  return [...value.matchAll(/\[([^\]]*)\]/g)]
    .map((match) => match[1].trim())
    .filter((tag) => !/^r(?:\s|$)/i.test(tag));
}

function hasUnbalancedPairedTags(value: string): boolean {
  const stack: string[] = [];
  for (const token of tagsIn(value)) {
    if (/\/\s*$/.test(token)) continue;
    const match = token.match(/^\s*(\/?)\s*([\w:-]+)/);
    if (!match || !PAIRED_TAGS.has(match[2].toLowerCase())) continue;
    const [, closing, name] = match;
    if (closing) {
      if (stack.pop() !== name.toLowerCase()) return true;
    } else {
      stack.push(name.toLowerCase());
    }
  }
  return stack.length > 0;
}

function malformedBracket(value: string): boolean {
  let depth = 0;
  for (const char of value) {
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth < 0) return true;
    }
  }
  return depth !== 0;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    if (/[\u0000-\u00ff\uFF61-\uFF9F]/u.test(char)) {
      width += 1;
    } else {
      width += 2;
    }
  }
  return width;
}

function targetLineCount(value: string): number {
  return value.replace(/\[r\]/gi, "\n").split(/\r\n|\r|\n/).length;
}

export function analyzeLine(line: ScriptLine, maxChars = 42): LineAnalysis {
  const target = line.target;
  if (line.kind !== "dialogue" || target === null || !target.trim()) {
    return { status: "untranslated", issues: [], charCount: 0 };
  }

  const issues: string[] = [];
  if (/[�]|(?:Ã.|Â.)|(?:ã‚|ãƒ)/u.test(target)) {
    issues.push("Possible mojibake or replacement characters");
  }
  if (malformedBracket(target)) {
    issues.push("Unclosed or unmatched KAG bracket tag");
  }
  if (hasUnbalancedPairedTags(target)) {
    issues.push("Unclosed or mismatched paired KAG tags");
  }

  const sourceTags = tagsIn(line.source);
  const targetTags = tagsIn(target);
  if (sourceTags.join("|") !== targetTags.join("|")) {
    issues.push("KAG tags differ from the source");
  }

  const textOnly = target.replace(/\[r\]/gi, "\n").replace(/\[[^\]]*\]/g, "");
  const widths = textOnly.split(/\r\n|\r|\n/).map(displayWidth);
  const widest = Math.max(0, ...widths);
  const lineCount = targetLineCount(target);

  if (widest > maxChars) {
    issues.push(`Line width ${widest} exceeds ${maxChars} half-width characters`);
  }
  if (lineCount > 3) {
    issues.push(`Dialogue uses ${lineCount} lines; the limit is 3`);
  }

  const error = issues.some((issue) => issue.includes("KAG tag") || issue.includes("KAG tags") || issue.includes("bracket tag"));
  return {
    status: error ? "error" : issues.length > 0 ? "warning" : "ready",
    issues,
    charCount: widest,
  };
}

export function wrapLatinText(text: string, maxChars = 42, maxLines = 3): string {
  const tokens = text.split(/(\[[^\]]*\])/g);
  let lineWidth = 0;
  let lineCount = 1;
  let result = "";

  for (const token of tokens) {
    if (!token) continue;
    if (/^\[[^\]]*\]$/.test(token)) {
      result += token;
      if (/^\[r\]$/i.test(token)) {
        lineWidth = 0;
        lineCount += 1;
      }
      continue;
    }

    const chunks = token.match(/\s+|\S+/gu) ?? [];
    let pendingSpace = "";
    for (const chunk of chunks) {
      if (/^\s+$/u.test(chunk)) {
        pendingSpace += chunk;
        continue;
      }
      const width = displayWidth(chunk);
      const spaceWidth = displayWidth(pendingSpace);
      if (lineWidth > 0 && lineWidth + spaceWidth + width > maxChars && lineCount < maxLines) {
        result += "[r]";
        lineCount += 1;
        lineWidth = 0;
        pendingSpace = "";
      }
      result += pendingSpace + chunk;
      lineWidth += displayWidth(pendingSpace) + width;
      pendingSpace = "";
    }
    result += pendingSpace;
    lineWidth += displayWidth(pendingSpace);
  }

  return result;
}

export function createDemoDocument(): ScriptDocument {
  const sample = [
    "; A quiet evening — sample script",
    "*chapter_01",
    '@bg storage="evening_station" time=1000',
    "[name text=\"Mio\"]",
    "「もうこんな時間なんだね。」",
    "[name text=\"Ren\"]",
    "「ああ。帰り道、送っていくよ。」",
    "[wait time=400]",
    "電車の音が遠くで響いて、ミオは小さくうなずいた。",
    "[name text=\"Mio\"]",
    "「じゃあ、駅までお願いしようかな。」",
    "@playse storage=\"station_chime\"",
    "[l]",
    "ふたりは、夕暮れのホームをゆっくり歩き出した。",
    "[p]",
  ].join("\n");
  const document = parseKagScript(sample, "evening_station.ks");

  const translations = new Map<number, string>([
    [5, "Sudah malam juga, ya."],
    [7, "Iya. Aku antar sampai jalan pulang."],
    [9, "Suara kereta menggema pelan dari kejauhan. Mio mengangguk kecil."],
    [11, "Kalau begitu, temani aku sampai stasiun, ya."],
    [14, "Mereka berjalan perlahan menyusuri peron saat senja."],
  ]);

  return {
    ...document,
    lines: document.lines.map((line) => ({
      ...line,
      target: translations.get(line.lineNumber) ?? null,
    })),
  };
    }
    
