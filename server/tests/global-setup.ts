import { existsSync } from "node:fs";
import path from "node:path";
import { DEFAULT_RUBRIC_PATH, ROOT } from "../src/config.js";

/**
 * Say once, up front, why tests are being skipped. Without the supplied rubric the
 * marking tests skip themselves (see `hasRubric` in helpers.ts), and a run that only
 * reported "skipped" would read like a suite that had quietly stopped testing.
 */
export default function () {
  if (!existsSync(DEFAULT_RUBRIC_PATH)) {
    const where = path.relative(ROOT, DEFAULT_RUBRIC_PATH).split(path.sep).join("/");
    console.warn(
      `\n${where} not found: the tests that mark against the supplied rubric are skipped.\n` +
        "Everything else runs. See the README's Tests section.\n",
    );
  }
}
