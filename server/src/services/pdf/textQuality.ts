/**
 * Judging whether a PDF's embedded text layer can be trusted.
 *
 * `isBlank` is not a sufficient test for "can this paper be read". Phone scanner apps -
 * Adobe Scan among them - run their own OCR over the page and embed the result, so a
 * scanned handwritten script arrives with a text layer that is present but wrong:
 *
 *     "A Simpte electrie cixcut is a closed pth cheh cll oos Cuent to fhoo"
 *
 * That is worse than no text at all, because it looks like success. Marks would be
 * awarded against words the student never wrote, and every evidence quote would be
 * nonsense - while the pipeline reported full confidence.
 *
 * So the text layer gets scored, and a poor score routes the paper to the vision
 * extractor exactly as an empty one does.
 */

/** Function words that dominate any real English prose. */
const COMMON_WORDS = new Set(
  (
    "the a an and or but is are was were be been being am to of in on at for with from " +
    "by it its this that these those which who whom what when where why how all can " +
    "could should would will shall may might must not no nor yes if then than as so " +
    "because he she they we you i me my your his her their our there here have has had " +
    "do does did about into over under more most less least such only just also very " +
    "much many few some any each other another same different new old first last next " +
    "now while during before after between through against above below up down out off " +
    "again once both either neither own too"
  ).split(" "),
);

export interface TextQuality {
  /** 0..1. Roughly the share of words that are recognisable English function words. */
  score: number;
  /** True when the text layer should not be trusted for marking. */
  unreliable: boolean;
  reasons: string[];
}

/**
 * The threshold sits between the two populations actually observed: a clean text layer
 * from a typed PDF scores around 0.51, while an OCR layer over handwriting scores
 * around 0.34. Being wrong in the cautious direction costs one transcription call;
 * being wrong the other way marks the student on words they never wrote.
 */
const UNRELIABLE_BELOW = 0.45;

/** Too little text to judge, and too little to mark either way. */
const MIN_WORDS = 25;

export function assessTextLayer(text: string): TextQuality {
  const words = text.toLowerCase().match(/[a-z']{2,}/g) ?? [];
  const reasons: string[] = [];

  if (words.length < MIN_WORDS) {
    return {
      score: 0,
      unreliable: true,
      reasons: [`only ${words.length} words of text were found`],
    };
  }

  const common = words.filter((w) => COMMON_WORDS.has(w)).length;
  const score = common / words.length;

  if (score < UNRELIABLE_BELOW) {
    reasons.push(
      `only ${(score * 100).toFixed(0)}% of words are recognisable English (a clean text layer scores about 50%)`,
    );
  }

  // Two lexicon-free corroborations. Bad OCR scatters lone letters and produces
  // letter runs with no vowel in them; real prose does neither.
  const strays = (text.match(/(?:^|\s)[b-hj-z](?:\s|$)/gi) ?? []).length;
  const vowelless = words.filter((w) => w.length >= 4 && !/[aeiou]/.test(w)).length;
  if (strays > words.length * 0.02) {
    reasons.push(`${strays} stray single letters`);
  }
  if (vowelless > words.length * 0.02) {
    reasons.push(`${vowelless} words with no vowel`);
  }

  return { score: Number(score.toFixed(3)), unreliable: score < UNRELIABLE_BELOW, reasons };
}
