/**
 * Shared text normalisation.
 *
 * Text pulled out of a PDF does not look like the text a person sees. A sentence is
 * broken by a newline wherever the line wrapped, so the phrase "For example" can
 * arrive as "For\nexample" and any literal search for it fails. Everything that
 * matches against extracted text - quote anchoring and the offline grader's rules -
 * therefore works on a flattened copy and maps its results back to real offsets.
 */

export interface Mapped {
  text: string;
  /** map[i] is the index in the source string that produced text[i]. */
  map: number[];
}

/** Collapse all whitespace runs to a single space. Case and spelling are preserved. */
export function flatten(input: string): Mapped {
  const out: string[] = [];
  const map: number[] = [];
  let lastWasSpace = true;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      if (!lastWasSpace) {
        out.push(" ");
        map.push(i);
        lastWasSpace = true;
      }
      continue;
    }
    out.push(ch);
    map.push(i);
    lastWasSpace = false;
  }
  while (out.length > 0 && out[out.length - 1] === " ") {
    out.pop();
    map.pop();
  }
  return { text: out.join(""), map };
}

/**
 * Misspellings we expect to see, either from a student writing at speed or from an
 * OCR pass over a scan. Used both to make matching tolerant and to raise the spelling
 * annotations a teacher would write on the page.
 */
export const MISSPELLINGS: Record<string, string> = {
  circut: "circuit",
  circiut: "circuit",
  curent: "current",
  amether: "ammeter",
  amoeter: "ammeter",
  voltmetre: "voltmeter",
  resistence: "resistance",
  potentail: "potential",
  eqilibrium: "equilibrium",
  equlibrium: "equilibrium",
  quantitiy: "quantity",
  suply: "supply",
  demmand: "demand",
  becuase: "because",
  recieve: "receive",
  seperate: "separate",
  thier: "their",
  definately: "definitely",
  occured: "occurred",
  sholud: "should",
  knowlege: "knowledge",
  studnets: "students",
};

/**
 * Lower-case and spell-correct a flattened string for pattern matching, keeping a map
 * back to the flattened text so a match can still be reported against what the student
 * actually wrote. A grader that fails to credit a correct point purely because the
 * student wrote "curent" is not marking the answer, it is marking the typing.
 */
export function toMatchable(flatText: string): Mapped {
  const out: string[] = [];
  const map: number[] = [];
  const wordRe = /[A-Za-z']+|[^A-Za-z']+/g;
  let match: RegExpExecArray | null;

  while ((match = wordRe.exec(flatText)) !== null) {
    const chunk = match[0];
    const at = match.index;
    const replacement = MISSPELLINGS[chunk.toLowerCase()];

    if (replacement) {
      for (let j = 0; j < replacement.length; j++) {
        out.push(replacement[j]!);
        // Characters beyond the original word's length collapse onto its last
        // character, which keeps every index inside the original word.
        map.push(at + Math.min(j, chunk.length - 1));
      }
    } else {
      for (let j = 0; j < chunk.length; j++) {
        out.push(chunk[j]!.toLowerCase());
        map.push(at + j);
      }
    }
  }

  return { text: out.join("").toLowerCase(), map };
}

/** The sentence containing `index`, taken from already-flattened text. */
export function sentenceAt(flatText: string, index: number): string {
  const start = flatText.lastIndexOf(".", Math.max(0, index - 1)) + 1;
  const stop = flatText.indexOf(".", index);
  const end = stop === -1 ? flatText.length : stop + 1;
  return flatText.slice(start, end).trim();
}
