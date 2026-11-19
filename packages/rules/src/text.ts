export class InvalidTextDiff extends Error { constructor() { super('invalid_text_diff'); } }
export type TextLine = { text: string; inputLine: number; sourceLine: number | null };
export function inputLines(text: string) { return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'); }

// Only counts and added text are interpreted. Names remain opaque data and are never applied to a filesystem.
export function selectText(text: string, format: 'snippet' | 'unified_diff'): TextLine[] {
  const lines = inputLines(text);
  if (format === 'snippet') return lines.map((value, index) => ({ text: value, inputLine: index + 1, sourceLine: null }));
  let cursor = 0;
  if (lines[cursor]?.startsWith('diff --git ')) { cursor++; if (lines[cursor]?.startsWith('index ')) cursor++; }
  if (!lines[cursor]?.startsWith('--- ') || !lines[cursor + 1]?.startsWith('+++ ')) throw new InvalidTextDiff();
  cursor += 2; let oldEnd = -1; let newEnd = -1; let hunks = 0;
  const selected: TextLine[] = [];
  while (cursor < lines.length) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(lines[cursor]!);
    if (!match) throw new InvalidTextDiff();
    const oldStart = Number(match[1]); const newStart = Number(match[3]);
    let oldLeft = Number(match[2] ?? 1); let newLeft = Number(match[4] ?? 1);
    if ([oldStart, newStart, oldLeft, newLeft].some(value => !Number.isSafeInteger(value) || value < 0 || value > 100_000_000)
      || oldLeft > 1000 || newLeft > 1000 || oldStart < oldEnd || newStart < newEnd || (oldLeft > 0 && oldStart === 0) || (newLeft > 0 && newStart === 0)
      || oldStart + oldLeft > 100_000_000 || newStart + newLeft > 100_000_000) throw new InvalidTextDiff();
    oldEnd = oldStart + oldLeft; newEnd = newStart + newLeft; let sourceLine = newStart; let previousContent = false;
    cursor++; hunks++;
    while (oldLeft > 0 || newLeft > 0) {
      const value = lines[cursor]; if (value === undefined) throw new InvalidTextDiff();
      if (value === '\\ No newline at end of file' && previousContent) { cursor++; previousContent = false; continue; }
      const marker = value[0];
      if (marker === '+') { newLeft--; selected.push({ text: value.slice(1), inputLine: cursor + 1, sourceLine: sourceLine++ }); }
      else if (marker === '-') oldLeft--;
      else if (marker === ' ') { oldLeft--; newLeft--; sourceLine++; }
      else throw new InvalidTextDiff();
      if (oldLeft < 0 || newLeft < 0) throw new InvalidTextDiff();
      previousContent = true; cursor++;
    }
    if (lines[cursor] === '\\ No newline at end of file' && previousContent) cursor++;
  }
  if (hunks === 0) throw new InvalidTextDiff();
  return selected;
}
