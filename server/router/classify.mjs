// Deterministic task classifier: no model call, so classifying a trivial request costs nothing.
// Reads signals from the latest user message (and its attachments), with short follow-ups
// inheriting the task of the previous user turn. Produces a task type, a difficulty tier and the
// signals that led there (shown in the routing details).

// Task types and their base difficulty points.
const BASE = {
  simple: 0, // tier 1 (fast): ≤ 1 point
  rewrite: 0,
  summarization: 1,
  structured: 1,
  general: 2, // tier 2 (general): 2–3 points
  creative: 2,
  "data-analysis": 2,
  coding: 2,
  reasoning: 2,
  multimodal: 2,
  "long-document": 3,
  math: 3,
  debugging: 3, // tier 3 (advanced): ≥ 4 points — reached with hard signals, length, many requirements
};

const RULES = [
  ["debugging", /\b(debug|bug|stack ?trace|traceback|exception|segfault|null pointer|undefined is not|doesn'?t work|not working|fails? (?:to|with)|error:|TypeError|ReferenceError|SyntaxError|panic:|why (?:does|is) (?:my|this) (?:code|function|test))\b/i],
  ["coding", /```|\b(code|function|class|method|refactor|implement|algorithm|regex|sql|api|endpoint|typescript|javascript|python|java|c\+\+|rust|golang|react|component|compile|unit tests?|script|bash|dockerfile)\b/i],
  ["math", /\$[^$\n]+\$|\\(?:frac|int|sum|sqrt|lim)|\b(prove|proof|theorem|lemma|integral|derivative|equation|solve for|matrix|eigen|probability|calculate|compute)\b/i],
  ["data-analysis", /\b(dataset|csv|statistic|regression|correlat|pivot|data analysis|analy[sz]e (?:the|this) data)\b/i],
  ["creative", /\b(story|poem|lyrics|song|haiku|fiction|screenplay|creative|novel|character)\b/i],
  ["summarization", /\b(summari[sz]e|summary|tl;?dr|key points|main points)\b/i],
  ["rewrite", /\b(rewrite|rephrase|paraphrase|translate|proofread|fix (?:the )?grammar|make (?:it|this) (?:shorter|longer|formal|casual)|convert (?:this|it) to)\b/i],
  ["structured", /\b(json|yaml|xml|csv format|schema|table with|as a table)\b/i],
  ["reasoning", /\b(why|explain|compare|analy[sz]e|evaluate|trade-?offs?|pros and cons|plan|strategy|design|architecture|should i|which is better|step by step)\b/i],
];

const HARD = /\b(complex|optimi[sz]|architecture|distributed|concurren|race condition|deadlock|scalab|rigorous|prove|edge cases|multi-?step|in depth|in-depth|comprehensive|thorough|production[- ]ready|security|performance|design a system|from scratch)\b/gi;
const GREETING = /^(hi|hello|hey|yo|thanks|thank you|ok|okay|good (?:morning|evening|night))\b[\s!.?]*$/i;
const SIMPLE_Q = /^(what|who|when|where|which|is|are|does|do|can|how many|how much|define)\b[^\n]{0,140}\??$/i;

const words = (s) => (s.match(/\S+/g) ?? []).length;

/**
 * @param {{ messages: { role: string, content: string }[], system?: string, maxTokens?: number, images?: number, continuation?: boolean }} req
 */
export function classify(req) {
  const users = req.messages.filter((m) => m.role === "user");
  const last = users.at(-1)?.content ?? "";
  // Attachments arrive inlined as <file …> blocks; the user's own words follow them.
  const files = [...last.matchAll(/<file name="([^"]*)">\n([\s\S]*?)\n<\/file>/g)];
  const attachedChars = files.reduce((n, f) => n + f[2].length, 0);
  const own = last.replace(/<file name="[^"]*">\n[\s\S]*?\n<\/file>/g, "").trim();

  const signals = [];
  let type = "general";
  for (const [t, re] of RULES) {
    if (re.test(own) || (t === "coding" && files.some((f) => /\.(m?[jt]sx?|py|java|go|rs|c|cpp|cs|rb|php|sql|sh)$/i.test(f[1])))) {
      type = t;
      signals.push(t);
      break;
    }
  }
  // Greetings, short factual questions and very short instructions ("Say hi in three words") are quick.
  const firstTurn = users.length === 1;
  if (type === "general" && !attachedChars && (GREETING.test(own) || (SIMPLE_Q.test(own) && words(own) <= 20) || (firstTurn && words(own) <= 8))) type = "simple";

  // A short follow-up ("and in Python?", "why?") continues the previous task.
  const previous = users.at(-2)?.content ?? "";
  if (users.length > 1 && words(own) <= 8 && !attachedChars && (type === "general" || type === "simple" || type === "reasoning")) {
    const prev = classifyText(previous);
    if (prev !== "general" && BASE[prev] >= BASE[type]) {
      signals.push(`follow-up of ${prev}`);
      type = prev;
    }
  }
  if (req.continuation) signals.push("continuation");

  let points = BASE[type] ?? 1;
  const hard = new Set((own.match(HARD) ?? []).map((w) => w.toLowerCase()));
  if (hard.size) {
    points += Math.min(2, hard.size);
    signals.push(`hard: ${[...hard].slice(0, 3).join(", ")}`);
  }
  const n = words(own);
  if (n > 150) points += 1;
  if (n > 600) points += 1;
  if ((own.match(/^\s*(?:\d+[.)]|[-*])\s+/gm) ?? []).length >= 3) {
    points += 1;
    signals.push("multiple requirements");
  }
  const codeLines = (own.match(/```[\s\S]*?```/g) ?? []).reduce((k, b) => k + b.split("\n").length, 0);
  if (codeLines > 40) {
    points += 1;
    signals.push(`${codeLines} lines of code`);
  }

  const promptChars = (req.system?.length ?? 0) + req.messages.reduce((k, m) => k + m.content.length, 0);
  const promptTokens = Math.ceil(promptChars / 3); // conservative, as server/tokens.mjs
  if (attachedChars > 60_000 || promptTokens > 100_000) {
    signals.push(`large input (~${Math.round(promptTokens / 1000)}K tokens)`);
    if (type === "general" || type === "simple" || type === "summarization") type = "long-document";
    points += 1;
  }
  if (req.images) {
    type = "multimodal";
    signals.push(`${req.images} image(s)`);
  }

  const tier = points <= 1 ? "fast" : points <= 3 ? "general" : "advanced";
  return { type, tier, points, signals, promptTokens };
}

/** Task type of a single message (used for follow-ups). */
function classifyText(text) {
  const own = text.replace(/<file name="[^"]*">\n[\s\S]*?\n<\/file>/g, "");
  for (const [t, re] of RULES) if (re.test(own)) return t;
  return "general";
}
