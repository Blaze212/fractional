export function buildResumeParsePrompt(resumeText: string): string {
  return `Parse the following resume text and return a structured JSON profile. Extract only information that is explicitly present in the text.

---RESUME TEXT START---
${resumeText}
---RESUME TEXT END---`
}
