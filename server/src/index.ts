import { config, resolveProvider } from "./config.js";
import { createApp } from "./app.js";

const app = createApp();

app.listen(config.port, () => {
  const provider = resolveProvider();
  console.log(`[gradesense] listening on http://localhost:${config.port}`);
  if (provider === "anthropic") {
    console.log(`[gradesense] grading with ${config.model}`);
  } else if (provider === "gemini") {
    console.log(`[gradesense] grading with ${config.geminiModel} (Gemini free tier)`);
  } else if (provider === "groq") {
    console.log(`[gradesense] grading with ${config.groqModel} via ${config.groqBaseUrl}`);
    console.log(
      "[gradesense] note: Groq is text-only, so the two diagram questions will be flagged for review",
    );
  } else {
    console.log(
      "[gradesense] no grading API key set - using the deterministic offline grader",
    );
  }
});
