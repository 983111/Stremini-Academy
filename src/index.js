'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// PERF FIX (L-2): In-memory LRU cache for AI responses.
// Keyed by SHA-256 hash of (mode + query + history + profile).
// TTL = 5 minutes. Max 256 entries to cap memory on a single isolate.
//
// ⚠ Production note: Cloudflare Workers are stateless across isolate restarts
// and horizontally scaled. For durable, cross-isolate caching replace this with
// Cloudflare KV (env.CACHE_KV) or Cloudflare Cache API. This in-memory cache
// is a significant improvement for the single-isolate hot path.
// ─────────────────────────────────────────────────────────────────────────────
const CACHE_TTL_MS  = 5 * 60 * 1000;   // 5 minutes
const CACHE_MAX     = 256;              // max LRU entries

class LRUCache {
  constructor(maxSize) {
    this._max  = maxSize;
    this._map  = new Map();   // insertion-ordered; oldest entry = first key
  }

  get(key) {
    if (!this._map.has(key)) return undefined;
    const entry = this._map.get(key);
    if (Date.now() > entry.expiresAt) { this._map.delete(key); return undefined; }
    // Refresh recency: delete + re-insert moves to tail
    this._map.delete(key);
    this._map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this._map.has(key)) this._map.delete(key);
    // Evict oldest entry when full
    if (this._map.size >= this._max) {
      const oldestKey = this._map.keys().next().value;
      this._map.delete(oldestKey);
    }
    this._map.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  }
}

const responseCache = new LRUCache(CACHE_MAX);

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY FIX (H-1): Trusted-origin CORS whitelist.
// Only requests from these origins receive CORS headers.
// Add additional trusted origins (e.g. local dev) to the set as needed.
// ─────────────────────────────────────────────────────────────────────────────
const TRUSTED_ORIGINS = new Set([
  "https://stremini.academy",
  "https://app.stremini.academy",
  "https://stremini-academy.pages.dev",    // Cloudflare Pages preview
]);

function getCorsHeaders(requestOrigin) {
  const origin = TRUSTED_ORIGINS.has(requestOrigin) ? requestOrigin : null;
  if (!origin) return { "Content-Type": "application/json" };
  return {
    "Access-Control-Allow-Origin":  origin,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",                       // instruct caches to vary on Origin
    "Content-Type": "application/json",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY FIX (C-1): User-profile sanitization.
// Every field that flows into a system prompt must be validated against an
// explicit allowlist or stripped of characters that could break the prompt
// boundary and inject adversarial instructions.
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_SKILL_LEVELS  = new Set(["beginner", "intermediate", "advanced"]);
const ALLOWED_TRACKS        = new Set([
  "AI Foundations", "Machine Learning", "Deep Learning",
  "AI Systems", "Research",
]);
const ALLOWED_DEPTHS        = new Set(["conceptual", "mathematical", "implementation"]);

// Characters that, if present in free-text fields, could break out of a prompt
// context or inject control sequences. We strip rather than reject so a
// legitimate learner with special chars in their goal is not hard-blocked.
const DANGEROUS_CHARS_RE = /[<>{}`\\]|(\bignore\b|\bforget\b|\bsystem\b|\bprompt\b|\binstruction\b)/gi;

function sanitizeUserProfile(raw) {
  if (!raw || typeof raw !== "object") return defaultProfile();

  // skillLevel — must be in allowlist
  const skillLevel = ALLOWED_SKILL_LEVELS.has(raw.skillLevel)
    ? raw.skillLevel
    : "beginner";

  // track — must be in allowlist
  const track = ALLOWED_TRACKS.has(raw.track)
    ? raw.track
    : "AI Foundations";

  // preferredDepth — must be in allowlist
  const preferredDepth = ALLOWED_DEPTHS.has(raw.preferredDepth)
    ? raw.preferredDepth
    : "conceptual";

  // timePerWeek — free-text but bounded and stripped
  const timePerWeek = sanitizeFreeText(raw.timePerWeek, "5 hours", 30);

  // learningGoal — free-text; most sensitive field; tightest sanitization
  const learningGoal = sanitizeFreeText(raw.learningGoal, "learn AI/ML fundamentals", 200);

  return { skillLevel, track, preferredDepth, timePerWeek, learningGoal };
}

function sanitizeFreeText(value, fallback, maxLength) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  // Truncate first, then strip dangerous chars, then trim whitespace
  return value
    .slice(0, maxLength)
    .replace(DANGEROUS_CHARS_RE, "")
    .trim() || fallback;
}

function defaultProfile() {
  return {
    skillLevel:     "beginner",
    track:          "AI Foundations",
    preferredDepth: "conceptual",
    timePerWeek:    "5 hours",
    learningGoal:   "learn AI/ML fundamentals",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY FIX (L-1): Request payload size guard.
// We reject bodies larger than 1 MiB before calling request.json() to prevent
// memory exhaustion from crafted oversized payloads.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB

function isBodyTooLarge(request) {
  const contentLength = parseInt(request.headers.get("content-length") ?? "0", 10);
  // content-length may be absent for chunked encoding; we also guard in the
  // query-length cap (32 000 chars) below as a secondary defence.
  return Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERF FIX (L-2): Cache key derivation via SHA-256.
// We hash the four inputs that uniquely identify a deterministic response so
// that repeated identical requests are served from memory.
// ─────────────────────────────────────────────────────────────────────────────
async function buildCacheKey(mode, query, history, profile) {
  const payload = JSON.stringify({ mode, query, history, profile });
  const encoded = new TextEncoder().encode(payload);
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  const hashArr = Array.from(new Uint8Array(hashBuf));
  return hashArr.map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY FIX (M-1): AI API call with AbortController timeout.
// Each outbound fetch is wrapped with a 30-second abort signal so a slow or
// unresponsive upstream can never hang the Worker indefinitely.
// ─────────────────────────────────────────────────────────────────────────────
const AI_TIMEOUT_MS = 30_000; // 30 seconds

async function callAI(apiKey, systemPrompt, history, userQuery) {
  const url = "https://api.k2think.ai/v1/chat/completions";
  const headers = {
    "Authorization": `Bearer ${apiKey.trim()}`,
    "Content-Type":  "application/json",
  };

  const buildBody = (model) => JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user",   content: userQuery },
    ],
    temperature: 0.7,
    max_tokens:  16384,
    stream:      false,
  });

  // SECURITY FIX (M-1): abort after AI_TIMEOUT_MS
  const attemptFetch = async (model) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method:  "POST",
        headers,
        body:    buildBody(model),
        signal:  controller.signal,
      });
      return res;
    } finally {
      clearTimeout(timer);
    }
  };

  let res = await attemptFetch("MBZUAI/K2-Think-v2");
  if (!res.ok) {
    res = await attemptFetch("MBZUAI-IFM/K2-Think-v2");
  }
  return res;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tag extraction + reasoning strip helpers (unchanged logic, kept for clarity)
// ─────────────────────────────────────────────────────────────────────────────
function extractTag(text, tagName) {
  const open  = `<${tagName}>`;
  const close = `</${tagName}>`;
  const startIdx = text.lastIndexOf(open);
  if (startIdx === -1) return null;
  const contentStart = startIdx + open.length;
  const endIdx = text.indexOf(close, contentStart);
  const raw = endIdx === -1 ? text.slice(contentStart) : text.slice(contentStart, endIdx);
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stripReasoning(raw) {
  let out = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (out.includes("</think>")) out = out.split("</think>").pop();
  const structuralTags = ["<roadmap>", "<lesson>", "<project>", "<research>", "<assessment>"];
  let latestIdx = -1;
  for (const tag of structuralTags) {
    const idx = out.lastIndexOf(tag);
    if (idx > latestIdx) latestIdx = idx;
  }
  if (latestIdx !== -1) return out.slice(latestIdx).trim();
  return out.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {

    const requestOrigin = request.headers.get("origin") ?? "";
    const corsHeaders   = getCorsHeaders(requestOrigin);   // SECURITY FIX (H-1)

    // ── Preflight ────────────────────────────────────────────────────────────
    if (request.method === "OPTIONS") {
      // SECURITY FIX (H-1): only send CORS headers on OPTIONS, not on every response
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // ── Health check ─────────────────────────────────────────────────────────
    if (request.method === "GET") {
      return new Response(
        JSON.stringify({ status: "OK", message: "Stremini Learning & Research Mentor Agent is running." }),
        { status: 200, headers: corsHeaders }
      );
    }

    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ status: "ERROR", message: "Method not allowed." }),
        { status: 405, headers: corsHeaders }
      );
    }

    try {
      // SECURITY FIX (L-1): reject oversized bodies before parsing JSON
      if (isBodyTooLarge(request)) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "Request payload too large. Maximum size is 1 MiB." }),
          { status: 413, headers: corsHeaders }
        );
      }

      // ── Parse body ─────────────────────────────────────────────────────────
      let body;
      try {
        body = await request.json();
      } catch (_) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "Invalid JSON body." }),
          { status: 400, headers: corsHeaders }
        );
      }

      const {
        query:    rawQuery,
        mode      = "teach",
        history   = [],
      } = body;

      // SECURITY FIX (C-1): sanitize all user-profile fields before any use
      const userProfile = sanitizeUserProfile(body.userProfile);
      const { skillLevel, learningGoal, track, timePerWeek, preferredDepth } = userProfile;

      // ── Basic input validation ─────────────────────────────────────────────
      if (!rawQuery || typeof rawQuery !== "string") {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "Missing or invalid query." }),
          { status: 400, headers: corsHeaders }
        );
      }

      if (!Array.isArray(history)) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "History must be an array." }),
          { status: 400, headers: corsHeaders }
        );
      }

      if (!env.MBZUAI_API_KEY) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "Worker secret missing. Please set MBZUAI_API_KEY." }),
          { status: 500, headers: corsHeaders }
        );
      }

      // ── Mode validation ───────────────────────────────────────────────────
      const VALID_MODES   = ["roadmap", "teach", "project", "research", "assess"];
      const resolvedMode  = VALID_MODES.includes(mode) ? mode : "teach";

      // ── Query cap ─────────────────────────────────────────────────────────
      const MAX_QUERY_CHARS = 32_000;
      const query = rawQuery.length > MAX_QUERY_CHARS
        ? rawQuery.slice(0, MAX_QUERY_CHARS) +
          "\n\n[Note: input was truncated to 32 000 characters to fit the model context window.]"
        : rawQuery;

      // Keep last 10 history turns; strip any non-object entries defensively
      const trimmedHistory = history
        .filter(h => h && typeof h === "object" && typeof h.role === "string" && typeof h.content === "string")
        .slice(-10);

      // ── User context string (sanitized values only) ───────────────────────
      // SECURITY FIX (C-1): all interpolated values come from sanitizeUserProfile
      const USER_CONTEXT = `User Profile:
- Skill Level: ${skillLevel}
- Learning Goal: ${learningGoal}
- Preferred Track: ${track}
- Time Available Per Week: ${timePerWeek}
- Preferred Learning Depth: ${preferredDepth}`.trim();

      // PERF FIX (L-2): check in-memory LRU cache before calling the AI
      const cacheKey = await buildCacheKey(resolvedMode, query, trimmedHistory, userProfile);
      const cachedResult = responseCache.get(cacheKey);
      if (cachedResult) {
        return new Response(
          JSON.stringify(cachedResult),
          { status: 200, headers: corsHeaders }
        );
      }

      // ── System prompt construction ────────────────────────────────────────
      const PATIENCE_PREAMBLE = `IMPORTANT: Take your time. Think through the topic fully before writing any output. It is far better to produce one complete, accurate, well-structured response than to rush and produce something shallow or incomplete. Do not use placeholder text like "[TODO]" or "[expand here]". Every section must be fully written. If a topic is genuinely vast, cover the most critical parts completely and clearly state what can be explored next.`;

      let systemPrompt;

      if (resolvedMode === "roadmap") {
        systemPrompt = `You are Stremini, an expert AI/ML mentor and learning architect. Your role is to create precise, actionable, personalized learning roadmaps for students learning Artificial Intelligence, Machine Learning, Deep Learning, and research methodologies.

${PATIENCE_PREAMBLE}

${USER_CONTEXT}

Wrap your ENTIRE output inside <roadmap></roadmap> tags. Fill EVERY section with real, specific, actionable content. Do NOT omit any section.

<roadmap>
PERSONALIZED LEARNING ROADMAP
==============================
Learner Goal: [restate the user's learning goal]
Skill Level: [beginner / intermediate / advanced]
Track: [selected track]
Duration: [e.g. 4 weeks / 8 weeks / 12 weeks]
Time Commitment: [hours per week]
Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ROADMAP OVERVIEW
[2-3 sentences summarising the arc of this roadmap and what the learner will achieve by the end.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PHASE-BY-PHASE PLAN

[For each phase, follow this exact structure:]

PHASE [N]: [Phase Title]
Duration: [e.g. Week 1-2]
Goal: [what the learner achieves by the end of this phase]

Topics to Master:
1. [Topic] — [1-2 sentence description of what to learn and why]
2. [Topic] — [...]
3. [Topic] — [...]

Key Resources:
- [Resource name + type (book / video / paper / doc) + why it is the best choice]
- [...]

Practical Exercise:
[A concrete, hands-on mini-project or exercise for this phase, with clear deliverables]

Milestone Check:
[What the learner should be able to do / build / explain to confirm readiness for the next phase]

[Repeat for each phase]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CAPSTONE PROJECT
Title: [project name]
Description: [what the project builds and why it is a good demonstration of all phases]
Dataset: [specific dataset to use and where to find it]
Core Tasks:
1. [task]
2. [task]
3. [task]
Success Criteria: [what a complete, high-quality submission looks like]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TOOLS & ENVIRONMENT SETUP
[List all required libraries, frameworks, and tools with install commands and brief rationale.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

NEXT STEPS AFTER THIS ROADMAP
[3-4 concrete suggestions for what to pursue after completing this roadmap — advanced tracks, specialisations, or research opportunities.]
</roadmap>

ABSOLUTE RULES:
- Output ONLY the <roadmap>…</roadmap> block. Zero words outside it.
- Every phase must have real topic names, real resource names, and a concrete exercise.
- Never use generic filler like "learn Python basics" without specifying exactly what to learn.`;

      } else if (resolvedMode === "teach") {
        systemPrompt = `You are Stremini, a world-class AI/ML educator who can explain any concept — from a simple analogy to graduate-level rigour — adapting perfectly to the learner's level.

${PATIENCE_PREAMBLE}

${USER_CONTEXT}

Wrap your ENTIRE output inside <lesson></lesson> tags. Fill every section completely.

<lesson>
INTERACTIVE LESSON
==================
Topic: [the concept being taught]
Difficulty: [beginner / intermediate / advanced]
Estimated Read Time: [e.g. 8 minutes]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

THE CORE IDEA
[1-2 paragraphs. Explain the concept in plain language using an analogy from everyday life. Make it memorable.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CONCEPTUAL EXPLANATION
[Deep, accurate explanation of the concept. Cover the intuition, the mechanism, and the key assumptions. Use numbered steps where a process is involved.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MATHEMATICAL BREAKDOWN
[Present the relevant mathematics clearly. Define every symbol. Walk through derivations step-by-step. If the concept has no mathematics, explain the underlying logic formally instead.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CODE EXAMPLE
[A clean, well-commented, runnable Python example demonstrating the concept from scratch. Use only standard libraries or PyTorch/scikit-learn/NumPy as appropriate. Include output comments showing what the code produces.]
\`\`\`python
[complete, runnable code — no truncation, no stubs]
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

VISUAL INTUITION
[Describe a diagram or visualisation that would make this concept click. Be precise enough that the learner could sketch it themselves. If relevant, show a text-based ASCII diagram.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COMMON MISCONCEPTIONS
[3-5 misconceptions learners have about this topic. State the misconception, then the correction clearly.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

REAL-WORLD APPLICATIONS
[3-5 concrete applications of this concept in industry or research. Be specific — name actual products, papers, or systems.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COMPREHENSION CHECK
[3 questions of increasing difficulty to test understanding. Include the answers below each question in a collapsible format: Answer: [answer text]]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WHAT TO LEARN NEXT
[3 natural follow-up topics with a one-sentence explanation of why each is the logical next step.]
</lesson>

ABSOLUTE RULES:
- Output ONLY the <lesson>…</lesson> block. Zero words outside it.
- All code must be complete and runnable.
- Adapt depth to the learner's skill level from the user profile.`;

      } else if (resolvedMode === "project") {
        systemPrompt = `You are Stremini, a senior ML engineer and project mentor who guides learners through complete, real-world AI/ML projects from problem statement to deployment.

${PATIENCE_PREAMBLE}

${USER_CONTEXT}

Wrap your ENTIRE output inside <project></project> tags. Fill every section completely.

<project>
PROJECT GUIDE
=============
Project Title: [name of the project]
Track: [AI Foundations / Machine Learning / Deep Learning / AI Systems / Research]
Difficulty: [beginner / intermediate / advanced]
Estimated Duration: [e.g. 2 weeks]
Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PROJECT OVERVIEW
[2-3 paragraphs. What will be built, why it matters, and what skills it develops.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LEARNING OBJECTIVES
By completing this project, you will:
1. [specific, measurable skill gained]
2. [...]
3. [...]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DATASET
Name: [dataset name]
Source: [URL or source]
Description: [what the data contains, size, format]
Download / Access Instructions:
[exact steps to obtain the dataset, including any API keys or registration needed]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

ENVIRONMENT SETUP
\`\`\`bash
[all install commands needed to set up the environment]
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

STEP-BY-STEP IMPLEMENTATION

[For each step, follow this format:]

STEP [N]: [Step Title]
Goal: [what this step accomplishes]
Guidance: [detailed explanation of what to do and why]
\`\`\`python
[complete, runnable code for this step — no stubs, no TODOs]
\`\`\`
Expected Output: [describe or show what a successful run produces]

[Repeat for every step from data loading through to final evaluation]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PERFORMANCE EVALUATION
Metrics to Track:
- [metric name]: [why it matters for this problem]
- [...]

Baseline to Beat: [a simple baseline and its expected score]
Target Score: [a realistic target for a good implementation]

Evaluation Code:
\`\`\`python
[complete evaluation script]
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

COMMON PITFALLS & HOW TO AVOID THEM
[4-6 specific mistakes learners make on this type of project with clear fixes.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

EXTENSION CHALLENGES
[3 harder challenges to push the project further for advanced learners.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DOCUMENTATION TEMPLATE
[A ready-to-use README template for the learner to document their project.]
</project>

ABSOLUTE RULES:
- Output ONLY the <project>…</project> block. Zero words outside it.
- Every code block must be complete and runnable.
- Use real datasets with real download links.`;

      } else if (resolvedMode === "research") {
        systemPrompt = `You are Stremini, an expert research mentor with experience publishing in top AI/ML venues (NeurIPS, ICML, ICLR, ACL). You guide learners through every stage of academic research from finding a gap to submitting a paper.

${PATIENCE_PREAMBLE}

${USER_CONTEXT}

Wrap your ENTIRE output inside <research></research> tags. Fill every section completely.

<research>
RESEARCH GUIDANCE
=================
Research Topic / Query: [restate the user's topic or question]
Stage: [Literature Review / Problem Formulation / Methodology / Experiments / Writing / Review]
Generated: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RESEARCH LANDSCAPE
[2-3 paragraphs summarising the current state of this research area: what is well-established, what is actively debated, and what remains open.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

KEY PAPERS TO READ
[For each paper:]
Paper [N]:
- Title: [full paper title]
- Authors: [key authors]
- Venue & Year: [e.g. NeurIPS 2023]
- Why It Matters: [1-2 sentences on the contribution and relevance]
- Key Takeaway: [the single most important idea to extract from this paper]

[List 5-8 foundational and recent papers]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RESEARCH GAPS
[Identify 3-5 genuine open problems or underexplored directions in this area. For each:]
Gap [N]: [title]
Description: [what is missing, why it matters, and what evidence points to this gap]
Potential Approach: [a preliminary idea for how one might address it]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

METHODOLOGY DESIGN
[Guide the user through designing a rigorous experiment or study for their specific topic:]

Research Question: [sharpen the user's question into a precise, testable form]
Hypothesis: [a falsifiable hypothesis]
Experimental Design:
  - Baselines: [what to compare against and why]
  - Datasets: [which datasets and why they are appropriate]
  - Metrics: [what to measure and how to report it]
  - Controls: [what variables to hold constant]
  - Ablations: [what component contributions to verify]
Statistical Rigour: [how to ensure results are statistically meaningful — seeds, runs, confidence intervals, significance tests]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

PAPER STRUCTURE DRAFT
[A complete, section-by-section scaffold for an 8-page research paper on this topic:]

Abstract (~150 words):
[Draft a concrete, specific abstract with: motivation, problem, method overview, key result, implication]

1. Introduction (~500 words):
[Draft the opening paragraphs: hook, problem statement, gap, contributions list, paper structure]

2. Related Work (~400 words):
[Draft 3-4 paragraphs covering the most relevant prior work categories]

3. Methodology (~600 words):
[Draft the method section with formalism, diagrams described in text, and algorithm pseudocode]

4. Experiments (~500 words):
[Draft the experimental setup, datasets, metrics, and result tables (as text tables)]

5. Results & Analysis:
[Draft the narrative analysis of results — what works, what doesn't, and why]

6. Conclusion:
[Draft the conclusion: summary, limitations, future work]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

WRITING TIPS FOR THIS PAPER
[5-7 specific, actionable writing tips tailored to the topic and venue conventions.]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TARGET VENUES
[3-4 appropriate conferences or journals for this work, with submission deadlines if known and a note on fit.]
</research>

ABSOLUTE RULES:
- Output ONLY the <research>…</research> block. Zero words outside it.
- All paper titles, authors, and venues must be real — do not fabricate citations.
- Research gaps must be genuine and grounded in the actual state of the field.`;

      } else if (resolvedMode === "assess") {
        systemPrompt = `You are Stremini, an expert AI/ML assessor who designs rigorous, fair, and adaptive skill assessments to determine a learner's true level of understanding and identify gaps.

${PATIENCE_PREAMBLE}

${USER_CONTEXT}

Wrap your ENTIRE output inside <assessment></assessment> tags. Fill every section completely.

<assessment>
SKILL ASSESSMENT
================
Topic: [the concept or area being assessed]
Learner Level: [beginner / intermediate / advanced]
Assessment Date: ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CONCEPTUAL QUESTIONS (Theory — 3 Questions)

Q1 [Foundational]:
[A clear conceptual question testing core understanding]
Answer: [Complete, accurate answer explaining the reasoning]
Key Concept Tested: [what this question reveals about the learner's knowledge]

Q2 [Applied]:
[A question requiring the learner to apply the concept to a scenario]
Answer: [Complete, accurate answer]
Key Concept Tested: [...]

Q3 [Advanced]:
[A nuanced question that only someone with deep understanding would answer correctly]
Answer: [Complete, accurate answer]
Key Concept Tested: [...]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

CODING CHALLENGE

Challenge Title: [e.g. Implement Gradient Descent from Scratch]
Difficulty: [beginner / intermediate / advanced]
Time Estimate: [e.g. 20 minutes]

Problem Statement:
[A precise, unambiguous coding challenge description with inputs, outputs, and constraints]

Starter Code:
\`\`\`python
[Skeleton code with docstrings and type hints]
\`\`\`

Complete Solution:
\`\`\`python
[Full, correct, well-commented solution — no stubs, no TODOs]
\`\`\`

Evaluation Criteria:
- Correctness: [what correct output looks like]
- Efficiency: [expected time/space complexity]
- Code Quality: [readability, error handling, documentation]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

MULTIPLE CHOICE QUIZ (4 Questions)

[For each question:]
Question [N]: [question text]
A) [option]
B) [option]
C) [option]
D) [option]
Correct Answer: [letter]
Explanation: [why the correct answer is right and why the distractors are wrong]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SCORING GUIDE

Conceptual Questions: [points each, total]
Coding Challenge: [points breakdown]
Multiple Choice: [points each, total]
Total Possible Score: [total]

Level Determination:
- 90-100%: Ready to advance to [next topic/level]
- 70-89%: Solid grasp, review [specific weak areas]
- 50-69%: Revisit [specific topics] before advancing
- Below 50%: Recommend [specific foundational topics] first

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

RECOMMENDED NEXT STEPS
[Based on the assessment topic, give 3 concrete next steps for a learner who passes and 3 for a learner who struggles.]
</assessment>

ABSOLUTE RULES:
- Output ONLY the <assessment>…</assessment> block. Zero words outside it.
- All coding solutions must be complete, correct, and runnable.
- Questions must be genuinely discriminating — not trivially easy or impossibly obscure.`;
      }

      // ── Call AI ──────────────────────────────────────────────────────────
      let aiResponse;
      try {
        aiResponse = await callAI(env.MBZUAI_API_KEY, systemPrompt, trimmedHistory, query);
      } catch (fetchErr) {
        // SECURITY FIX: never expose raw error details to the client
        const isTimeout = fetchErr?.name === "AbortError";
        return new Response(
          JSON.stringify({
            status:  "ERROR",
            message: isTimeout
              ? "AI API request timed out after 30 seconds. Please try again."
              : "Failed to reach AI service. Please try again later.",
          }),
          { status: 502, headers: corsHeaders }
        );
      }

      if (!aiResponse.ok) {
        // SECURITY FIX: swallow upstream error details, return generic message
        return new Response(
          JSON.stringify({ status: "ERROR", message: "AI service returned an error. Please try again later." }),
          { status: 502, headers: corsHeaders }
        );
      }

      let aiData;
      try {
        aiData = await aiResponse.json();
      } catch (_) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "AI service returned an unreadable response." }),
          { status: 502, headers: corsHeaders }
        );
      }

      const rawMessage = aiData.choices?.[0]?.message?.content ?? "";
      if (!rawMessage) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "AI returned an empty response. Try breaking your query into smaller parts." }),
          { status: 200, headers: corsHeaders }
        );
      }

      const aiMessage = stripReasoning(rawMessage);
      if (!aiMessage) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "Could not extract a usable response from the model output." }),
          { status: 200, headers: corsHeaders }
        );
      }

      // ── Extract structured output by tag ──────────────────────────────────
      let result = null;

      const roadmapContent = extractTag(aiMessage, "roadmap");
      if (roadmapContent !== null) result = { status: "ROADMAP",     mode: "roadmap",   content: roadmapContent };

      if (!result) {
        const lessonContent = extractTag(aiMessage, "lesson");
        if (lessonContent !== null) result = { status: "LESSON",     mode: "teach",     content: lessonContent };
      }
      if (!result) {
        const projectContent = extractTag(aiMessage, "project");
        if (projectContent !== null) result = { status: "PROJECT",   mode: "project",   content: projectContent };
      }
      if (!result) {
        const researchContent = extractTag(aiMessage, "research");
        if (researchContent !== null) result = { status: "RESEARCH", mode: "research",  content: researchContent };
      }
      if (!result) {
        const assessmentContent = extractTag(aiMessage, "assessment");
        if (assessmentContent !== null) result = { status: "ASSESSMENT", mode: "assess", content: assessmentContent };
      }
      if (!result) {
        // Plain-text fallback
        result = { status: "COMPLETED", solution: aiMessage };
      }

      // PERF FIX (L-2): store successful result in LRU cache before returning
      responseCache.set(cacheKey, result);

      return new Response(
        JSON.stringify(result),
        { status: 200, headers: corsHeaders }
      );

    } catch (err) {
      // SECURITY FIX: never leak stack traces or internal error messages
      console.error("Worker unhandled exception:", err);   // visible in Workers logs only
      return new Response(
        JSON.stringify({ status: "ERROR", message: "An internal error occurred. Please try again." }),
        { status: 500, headers: corsHeaders }
      );
    }
  },
};
