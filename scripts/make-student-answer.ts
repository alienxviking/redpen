/**
 * Generates the student answer papers used to demonstrate and test GradeSense.
 *
 * The main paper (`student-answer.pdf`) is the deliverable the assignment asks the
 * candidate to write: a realistic script that mixes correct points, missing points,
 * wrong reasoning, spelling slips and layout problems. Generating it from code rather
 * than typing it into Word keeps every planted mistake reproducible and keeps the
 * error key honest - the key is derived from the same constants as the paper.
 *
 * The other papers are the edge cases the test suite needs: fully correct, wholly
 * incorrect, blank, and a heavily misspelled "OCR-like" variant of a good answer.
 *
 *   npm run seed
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "..", "fixtures");
const CASES = path.join(FIXTURES, "cases");

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;

/* ------------------------------------------------------------------ writer */

class Paper {
  private pdf!: PDFDocument;
  private page!: PDFPage;
  private y = 0;
  body!: PDFFont;
  head!: PDFFont;
  italic!: PDFFont;

  static async create(): Promise<Paper> {
    const paper = new Paper();
    paper.pdf = await PDFDocument.create();
    // A serif face reads like a written script rather than a UI.
    paper.body = await paper.pdf.embedFont(StandardFonts.TimesRoman);
    paper.head = await paper.pdf.embedFont(StandardFonts.TimesRomanBold);
    paper.italic = await paper.pdf.embedFont(StandardFonts.TimesRomanItalic);
    paper.newPage();
    return paper;
  }

  newPage(): PDFPage {
    this.page = this.pdf.addPage(A4);
    this.y = A4[1] - MARGIN;
    return this.page;
  }

  get cursor(): number {
    return this.y;
  }

  set cursor(value: number) {
    this.y = value;
  }

  get current(): PDFPage {
    return this.page;
  }

  space(amount: number): void {
    this.y -= amount;
  }

  /** Ensure `needed` points remain on the page, starting a new one otherwise. */
  reserve(needed: number): void {
    if (this.y - needed < MARGIN) this.newPage();
  }

  /** `force` writes the heading exactly where the cursor is, even at the page foot. */
  heading(text: string, opts: { force?: boolean } = {}): void {
    if (!opts.force) this.reserve(40);
    this.page.drawText(text, {
      x: MARGIN,
      y: this.y,
      size: 13,
      font: this.head,
      color: rgb(0.1, 0.1, 0.12),
    });
    this.y -= 22;
  }

  /**
   * Draw a paragraph. `indent` is used to plant the deliberate alignment problems -
   * a real script has blocks that do not line up.
   */
  paragraph(
    text: string,
    opts: { size?: number; indent?: number; lineHeight?: number; font?: PDFFont } = {},
  ): void {
    const size = opts.size ?? 10.5;
    const font = opts.font ?? this.body;
    const lineHeight = opts.lineHeight ?? size * 1.5;
    const indent = opts.indent ?? 0;
    const maxWidth = A4[0] - MARGIN * 2 - indent;

    for (const line of wrap(text, font, size, maxWidth)) {
      this.reserve(lineHeight);
      this.page.drawText(line, {
        x: MARGIN + indent,
        y: this.y,
        size,
        font,
        color: rgb(0.12, 0.12, 0.16),
      });
      this.y -= lineHeight;
    }
    this.y -= 6;
  }

  async save(file: string): Promise<void> {
    const bytes = await this.pdf.save();
    await fs.writeFile(file, bytes);
    console.log(`  wrote ${path.relative(process.cwd(), file)} (${bytes.length} bytes)`);
  }
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) line = candidate;
      else {
        if (line) lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/* ---------------------------------------------------------------- diagrams */

/**
 * The circuit diagram.
 *
 * `voltmeterInSeries` plants the substantive error: the voltmeter is wired into the
 * main loop instead of across the bulb, matching what the student's text claims.
 * `sloppyLabels` offsets a label and omits the current-direction arrow, which is the
 * layout/labelling problem the rubric's fifth point looks for.
 */
function drawCircuit(
  page: PDFPage,
  font: PDFFont,
  origin: { x: number; y: number },
  opts: { voltmeterInSeries: boolean; sloppyLabels: boolean },
): number {
  const w = 380;
  const h = 150;
  const { x, y } = origin;
  const wire = rgb(0.15, 0.15, 0.2);
  const line = (x1: number, y1: number, x2: number, y2: number) =>
    page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y2 }, thickness: 1.1, color: wire });
  const label = (text: string, lx: number, ly: number, size = 8) =>
    page.drawText(text, { x: lx, y: ly, size, font, color: rgb(0.2, 0.2, 0.25) });

  const top = y;
  const bottom = y - h;
  const left = x;
  const right = x + w;

  // Main loop, drawn as segments so components can sit in the gaps.
  line(left, top, left + 90, top); // to battery
  line(left + 130, top, left + 190, top); // battery to switch
  line(left + 225, top, left + 285, top); // switch to resistor
  line(left + 325, top, right, top); // resistor to right rail
  line(right, top, right, bottom + 95); // right rail down to ammeter
  line(right, bottom + 65, right, bottom); // ammeter to bottom rail
  line(left, top, left, bottom); // left rail

  // Battery.
  line(left + 90, top - 12, left + 90, top + 12);
  line(left + 100, top - 6, left + 100, top + 6);
  line(left + 110, top - 12, left + 110, top + 12);
  line(left + 120, top - 6, left + 120, top + 6);
  line(left + 90, top, left + 90, top);
  label("Battery", left + 82, top + 18);

  // Switch (drawn open-ish, as students do).
  page.drawCircle({ x: left + 190, y: top, size: 2, color: wire });
  page.drawCircle({ x: left + 225, y: top, size: 2, color: wire });
  line(left + 190, top, left + 220, top + 12);
  label("Switch", left + 190, top + 20);

  // Resistor.
  const zig = [0, 6, -6, 6, -6, 6, -6, 0];
  let zx = left + 285;
  let prev = top;
  for (const dy of zig) {
    line(zx, prev, zx + 5, top + dy);
    zx += 5;
    prev = top + dy;
  }
  line(zx, prev, left + 325, top);
  label(sloppyLabelText(opts.sloppyLabels), left + 278, top + (opts.sloppyLabels ? 26 : 18));

  // Ammeter in series on the right rail.
  page.drawCircle({ x: right, y: bottom + 80, size: 15, borderColor: wire, borderWidth: 1.1 });
  label("A", right - 3, bottom + 76, 9);
  label(opts.sloppyLabels ? "amether" : "Ammeter", right + 20, bottom + 76);

  // Bulb on the bottom rail.
  const bulbX = left + 150;
  line(left, bottom, bulbX - 15, bottom);
  page.drawCircle({ x: bulbX, y: bottom, size: 15, borderColor: wire, borderWidth: 1.1 });
  line(bulbX - 10, bottom - 10, bulbX + 10, bottom + 10);
  line(bulbX - 10, bottom + 10, bulbX + 10, bottom - 10);
  label("Bulb", bulbX - 10, bottom - 30);

  if (opts.voltmeterInSeries) {
    // WRONG: the voltmeter is cut into the bottom rail, in series with the bulb.
    line(bulbX + 15, bottom, bulbX + 75, bottom);
    page.drawCircle({ x: bulbX + 90, y: bottom, size: 15, borderColor: wire, borderWidth: 1.1 });
    label("V", bulbX + 87, bottom - 4, 9);
    line(bulbX + 105, bottom, right, bottom);
    label("Voltmeter", bulbX + 72, bottom - 30);
  } else {
    // CORRECT: the voltmeter hangs in parallel across the bulb.
    line(bulbX + 15, bottom, right, bottom);
    const dropY = bottom - 45;
    line(bulbX - 40, bottom, bulbX - 40, dropY);
    line(bulbX + 40, bottom, bulbX + 40, dropY);
    line(bulbX - 40, dropY, bulbX - 15, dropY);
    line(bulbX + 15, dropY, bulbX + 40, dropY);
    page.drawCircle({ x: bulbX, y: dropY, size: 15, borderColor: wire, borderWidth: 1.1 });
    label("V", bulbX - 3, dropY - 4, 9);
    label("Voltmeter (across bulb)", bulbX - 45, dropY - 30);
  }

  if (!opts.sloppyLabels) {
    // Conventional current direction arrow on the left rail.
    line(left, bottom + 60, left, bottom + 90);
    line(left, bottom + 90, left - 4, bottom + 82);
    line(left, bottom + 90, left + 4, bottom + 82);
    label("Conventional current", left + 8, bottom + 70);
  }

  return h + (opts.voltmeterInSeries ? 45 : 90);
}

function sloppyLabelText(sloppy: boolean): string {
  return sloppy ? "Resistor" : "Resistor (R)";
}

/**
 * The demand/supply graph. `swapAxes` plants the labelling error - price on the
 * horizontal axis instead of the vertical one - and `equilibrium` lets the wrong
 * intersection be marked to match the student's text.
 */
function drawGraph(
  page: PDFPage,
  font: PDFFont,
  origin: { x: number; y: number },
  opts: { swapAxes: boolean; equilibriumLabel: string; shiftDirection?: "left" | "right" },
): number {
  const w = 300;
  const h = 190;
  const { x, y } = origin;
  const axis = rgb(0.15, 0.15, 0.2);
  const left = x;
  const bottom = y - h;

  page.drawLine({ start: { x: left, y: bottom }, end: { x: left, y }, thickness: 1.2, color: axis });
  page.drawLine({
    start: { x: left, y: bottom },
    end: { x: left + w, y: bottom },
    thickness: 1.2,
    color: axis,
  });

  const xLabel = opts.swapAxes ? "Price (Rs)" : "Quantity";
  const yLabel = opts.swapAxes ? "Quantity" : "Price (Rs)";
  page.drawText(xLabel, { x: left + w / 2 - 20, y: bottom - 16, size: 8, font, color: axis });
  page.drawText(yLabel, { x: left - 30, y: y + 6, size: 8, font, color: axis });

  const demand = rgb(0.16, 0.35, 0.72);
  const supply = rgb(0.13, 0.5, 0.28);
  page.drawLine({
    start: { x: left + 20, y: y - 15 },
    end: { x: left + w - 20, y: bottom + 20 },
    thickness: 1.4,
    color: demand,
  });
  page.drawLine({
    start: { x: left + 20, y: bottom + 20 },
    end: { x: left + w - 20, y: y - 15 },
    thickness: 1.4,
    color: supply,
  });
  page.drawText("D", { x: left + w - 14, y: bottom + 18, size: 9, font, color: demand });
  page.drawText("S", { x: left + w - 14, y: y - 18, size: 9, font, color: supply });

  const mid = { x: left + w / 2, y: bottom + h / 2 - 0 };
  page.drawCircle({ x: mid.x, y: mid.y, size: 3, color: rgb(0.7, 0.1, 0.1) });
  page.drawText(opts.equilibriumLabel, {
    x: mid.x + 6,
    y: mid.y + 4,
    size: 8,
    font,
    color: rgb(0.7, 0.1, 0.1),
  });

  if (opts.shiftDirection) {
    const dx = opts.shiftDirection === "left" ? -28 : 28;
    page.drawLine({
      start: { x: left + 20 + dx, y: bottom + 20 },
      end: { x: left + w - 20 + dx, y: y - 15 },
      thickness: 1,
      color: rgb(0.5, 0.7, 0.55),
      dashArray: [3, 2],
    });
    page.drawText("S1", {
      x: left + w - 14 + dx,
      y: y - 30,
      size: 8,
      font,
      color: rgb(0.3, 0.55, 0.35),
    });
  }

  return h + 30;
}

/* ------------------------------------------------------------ answer texts */

const HEADER = (name: string) =>
  `Name: ${name}          Class: 10-B          Subject: Combined Paper          Total: 15 marks`;

/** The main deliverable: a believable script with a deliberate mix of mistakes. */
const MIXED = {
  q1: [
    "A simple electric circut is a closed path which allows curent to flow through it. The battery gives the potential difference which pushes the current around the loop. The switch is used to open and close the circut. When the switch is closed the path is complete and the current flows through the bulb, and when the switch is open the path is broken so no curent can flow.",
    "In my circut the battery, switch, resistor, bulb and the amether are all joined one after another in series in the main loop. The amether is put in series because it has to measure the curent that passes through the circut. The voltmeter is also connected in series with the bulb so that it can measure the voltage of the bulb.",
    "If the resistance of the circut is increased then the current also increases, because a bigger resistance pushes more current through the wire.",
  ],
  q2: [
    "Technology has changed the way studnets learn today. In my opinion technology makes learning much easier and better becuase information which was very hard to find earlier is now available in a few seconds on the internet. A student who does not understand a topic in the class can watch a video at home and understand it properly. For example when I could not understand the water cycle in the class, I watched two videos on the internet and after that I understood the whole topic very well.",
    "Technology also saves a lot of time becuase students do not have to search in many books in the library, they get all the informations immediately and they can spend that time on practice and revision instead which improves their knowlege and their marks in the exam also improve a lot and this is why every school should give tablets to all the students and the government should also provide free internet to every student in the country.",
  ],
  q3: [
    "The table shows the demand and the supply of the product at different prices. I have drawn the demmand curve and the suply curve on the graph below. I have taken the price on the horizontal axis and the quantity on the vertical axis. The demmand curve slopes downward because when the price is low the people buy more, and the suply curve slopes upward because when the price is high the sellers want to sell more.",
    "The two curves cut each other at the price of Rs 40 and the quantity of 40 units, and this point is the equilibrium of the market.",
    "When the price is below the equilibrium price the quantity demanded becomes more than the quantity supplied, so there is a shortage in the market and the price starts rising. When the price is above the equilibrium price the quantity supplied becomes more than the quantity demanded, so there is a surplus in the market and the price starts falling.",
    "If the cost of production increases then the producer has to spend more money on making the product, so the supply curve shifts to the right side. Because of this the new equilibrium will be at a lower price and a higher quantity than before.",
  ],
};

const CORRECT = {
  q1: [
    "A simple electric circuit provides a closed path through which electric current can flow. The battery provides the potential difference that drives the current around the circuit. The switch opens or closes the circuit: when it is closed there is a complete conducting path and current flows through the bulb and the resistor, and when it is open the path is broken and no current flows.",
    "The battery, switch, resistor, bulb and ammeter are all connected in series in the main circuit. The ammeter is connected in series because it measures the current flowing through the circuit. The voltmeter is connected in parallel across the bulb, because it measures the potential difference between the two ends of the bulb.",
    "The amount of current depends on the potential difference and on the resistance. By Ohm's law, V = IR. If the voltage of the battery stays constant and the resistance is increased, the current flowing through the circuit decreases; reducing the resistance allows more current to flow.",
    "The diagram below is labelled with every component and shows the direction of conventional current from the positive terminal of the battery through the external circuit back to the negative terminal.",
  ],
  q2: [
    "In my opinion technology does not automatically make students better or worse learners; its effect depends entirely on how it is used. Information that was once difficult to reach is now available in seconds, and a student who cannot follow a topic in class can watch several explanations until one of them makes sense. For example, a student struggling with the water cycle can compare three short videos and find the explanation that finally fits.",
    "However, easy access also creates a real danger. Students may become dependent on searching for an answer instead of working a problem out for themselves, and a student who looks up every difficult question may finish the homework without ever developing the reasoning that the homework was set to build. There is also the risk of accepting inaccurate information simply because it appears online.",
    "In conclusion, technology is most useful when it is used to understand concepts, explore ideas and check one's own work, rather than to copy answers. It should therefore be treated as a tool that supports thinking, not as a replacement for thinking.",
  ],
  q3: [
    "I have plotted the schedule with the quantity on the horizontal axis and the price on the vertical axis. The demand curve slopes downward from left to right because consumers demand a greater quantity at a lower price, and the supply curve slopes upward from left to right because producers are willing to supply more at a higher price.",
    "The two curves intersect at a price of Rs 30 and a quantity of 60 units. This is the market equilibrium, because at this price the quantity demanded is exactly equal to the quantity supplied.",
    "If the market price is below the equilibrium price, the quantity demanded is greater than the quantity supplied, which creates a shortage and puts upward pressure on the price. If the market price is above the equilibrium price, the quantity supplied is greater than the quantity demanded, which creates a surplus and puts downward pressure on the price.",
    "If the cost of production increases, producing becomes less profitable at every price, so producers supply less at each price and the supply curve shifts to the left. The new equilibrium is therefore at a higher price and a lower quantity, assuming demand is unchanged.",
  ],
};

const INCORRECT = {
  q1: [
    "An electric circuit is a wire which stores the current inside it. The battery is used to store the current and the switch is used to increase the speed of the current in the wire.",
    "The bulb and the resistor are connected in parallel with the battery. The ammeter is connected in parallel because it measures the voltage, and the voltmeter is connected in series with the bulb because it measures the current in the bulb.",
    "If the resistance of the circuit is increased then the current also increases, because the resistance gives extra push to the current.",
  ],
  q2: [
    "Technology is a very good thing and it is used by everybody in the world today. Mobile phones and computers are technology. Many people use technology every single day for many different purposes and it is present everywhere around us in the modern world.",
  ],
  q3: [
    "The graph shows the price and the quantity of the product in the market.",
    "The two curves meet at the price of Rs 10 and the quantity of 100 units and this is the equilibrium point of this market.",
    "If the cost of production increases then the supply curve shifts to the right and the new equilibrium will be at a lower price and a higher quantity.",
  ],
};

/** The correct answer, degraded the way a poor OCR pass degrades a scan. */
function ocrDegrade(text: string): string {
  const swaps: Array<[RegExp, string]> = [
    [/\bcircuit\b/g, "circut"],
    [/\bcurrent\b/g, "curent"],
    [/\bammeter\b/g, "amether"],
    [/\bresistance\b/g, "resistence"],
    [/\bpotential\b/g, "potentail"],
    [/\bequilibrium\b/g, "eqilibrium"],
    [/\bquantity\b/g, "quantitiy"],
    [/\bsupply\b/g, "suply"],
    [/\bbecause\b/g, "becuase"],
    [/\bstudents\b/g, "studnets"],
    [/\bknowledge\b/g, "knowlege"],
    [/\bseparate\b/g, "seperate"],
  ];
  let out = text;
  for (const [pattern, replacement] of swaps) out = out.replace(pattern, replacement);
  return out;
}

/* ------------------------------------------------------------------- build */

interface PaperOptions {
  name: string;
  content: { q1: string[]; q2: string[]; q3: string[] };
  voltmeterInSeries: boolean;
  sloppyLabels: boolean;
  swapAxes: boolean;
  equilibriumLabel: string;
  shiftDirection?: "left" | "right";
  /** Plant the layout problem: Q3's heading orphaned at the foot of the page. */
  crampedQ3: boolean;
}

async function buildPaper(opts: PaperOptions, file: string): Promise<void> {
  const paper = await Paper.create();

  paper.paragraph(HEADER(opts.name), { size: 8.5, font: paper.italic });
  paper.space(6);

  paper.heading("Question 1");
  opts.content.q1.forEach((text, i) =>
    // The second block is nudged out of alignment on the mixed paper - one of the
    // planted layout problems.
    paper.paragraph(text, { indent: opts.sloppyLabels && i === 1 ? 14 : 0 }),
  );
  paper.space(4);
  paper.reserve(230);
  const usedCircuit = drawCircuit(
    paper.current,
    paper.body,
    { x: MARGIN + 40, y: paper.cursor - 20 },
    { voltmeterInSeries: opts.voltmeterInSeries, sloppyLabels: opts.sloppyLabels },
  );
  paper.cursor = paper.cursor - usedCircuit - 40;

  paper.space(10);
  paper.heading("Question 2");
  opts.content.q2.forEach((text) => paper.paragraph(text));

  if (opts.crampedQ3) {
    // Planted layout problem: the Q3 heading is orphaned at the foot of the page and
    // its first line is squeezed in under it, so the answer breaks awkwardly.
    paper.cursor = MARGIN + 78;
    paper.heading("Question 3", { force: true });
    // The answer then runs over the page break mid-paragraph, which is exactly the
    // structural problem a teacher would mark.
    opts.content.q3.forEach((text) => paper.paragraph(text));
  } else {
    paper.space(8);
    paper.heading("Question 3");
    opts.content.q3.forEach((text) => paper.paragraph(text));
  }
  paper.space(4);
  paper.reserve(240);
  drawGraph(
    paper.current,
    paper.body,
    { x: MARGIN + 60, y: paper.cursor - 10 },
    {
      swapAxes: opts.swapAxes,
      equilibriumLabel: opts.equilibriumLabel,
      ...(opts.shiftDirection ? { shiftDirection: opts.shiftDirection } : {}),
    },
  );

  await paper.save(file);
}

async function buildBlank(file: string): Promise<void> {
  const paper = await Paper.create();
  // A genuinely empty script: ruled lines and nothing written on them.
  const page = paper.current;
  for (let i = 0; i < 24; i++) {
    page.drawLine({
      start: { x: MARGIN, y: 760 - i * 30 },
      end: { x: A4[0] - MARGIN, y: 760 - i * 30 },
      thickness: 0.4,
      color: rgb(0.85, 0.85, 0.88),
    });
  }
  await paper.save(file);
}

async function main(): Promise<void> {
  await fs.mkdir(CASES, { recursive: true });
  console.log("Generating answer papers...");

  await buildPaper(
    {
      name: "Aarav Mehta",
      content: MIXED,
      voltmeterInSeries: true,
      sloppyLabels: true,
      swapAxes: true,
      equilibriumLabel: "E (Rs 40, 40 units)",
      shiftDirection: "right",
      crampedQ3: true,
    },
    path.join(FIXTURES, "student-answer.pdf"),
  );

  await buildPaper(
    {
      name: "Test Case - fully correct",
      content: CORRECT,
      voltmeterInSeries: false,
      sloppyLabels: false,
      swapAxes: false,
      equilibriumLabel: "E (Rs 30, 60 units)",
      shiftDirection: "left",
      crampedQ3: false,
    },
    path.join(CASES, "answer-correct.pdf"),
  );

  await buildPaper(
    {
      name: "Test Case - incorrect",
      content: INCORRECT,
      voltmeterInSeries: true,
      sloppyLabels: true,
      swapAxes: true,
      equilibriumLabel: "E (Rs 10, 100 units)",
      shiftDirection: "right",
      crampedQ3: false,
    },
    path.join(CASES, "answer-incorrect.pdf"),
  );

  await buildPaper(
    {
      name: "Test Case - OCR spelling errors",
      content: {
        q1: CORRECT.q1.map(ocrDegrade),
        q2: CORRECT.q2.map(ocrDegrade),
        q3: CORRECT.q3.map(ocrDegrade),
      },
      voltmeterInSeries: false,
      sloppyLabels: false,
      swapAxes: false,
      equilibriumLabel: "E (Rs 30, 60 units)",
      shiftDirection: "left",
      crampedQ3: false,
    },
    path.join(CASES, "answer-ocr-errors.pdf"),
  );

  await buildBlank(path.join(CASES, "answer-blank.pdf"));

  console.log("Done.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
