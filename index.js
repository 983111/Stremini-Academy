export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Content-Type": "application/json",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

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
        query: rawQuery,
        mode = "teach",
        history = [],
        userProfile = {},
      } = body;

      if (!rawQuery || typeof rawQuery !== "string") {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "Missing or invalid query." }),
          { status: 400, headers: corsHeaders }
        );
      }

      if (!env.MBZUAI_API_KEY) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "Worker secret missing. Please set MBZUAI_API_KEY." }),
          { status: 500, headers: corsHeaders }
        );
      }

      // ── Validate mode ──────────────────────────────────────────────────────
      // Modes map to the 5 key features from the PRD:
      //  roadmap   → generate personalized learning roadmap
      //  teach     → interactive concept explanation
      //  project   → project-based learning guidance
      //  research  → research paper writing guidance
      //  assess    → quiz / skill assessment
      const VALID_MODES = ["roadmap", "teach", "project", "research", "assess"];
      const resolvedMode = VALID_MODES.includes(mode) ? mode : "teach";

      // ── Cap query length ───────────────────────────────────────────────────
      const MAX_QUERY_CHARS = 32000;
      const query =
        rawQuery.length > MAX_QUERY_CHARS
          ? rawQuery.slice(0, MAX_QUERY_CHARS) +
            "\n\n[Note: input was truncated to 32 000 characters to fit the model context window.]"
          : rawQuery;

      // Keep last 10 history turns for multi-turn context
      const trimmedHistory = history.slice(-10);

      // ── Build user context string from optional profile ────────────────────
      const skillLevel = userProfile.skillLevel || "beginner";
      const learningGoal = userProfile.learningGoal || "learn AI/ML fundamentals";
      const track = userProfile.track || "AI Foundations";
      const timePerWeek = userProfile.timePerWeek || "5 hours";
      const preferredDepth = userProfile.preferredDepth || "conceptual";

      const USER_CONTEXT = `
User Profile:
- Skill Level: ${skillLevel}
- Learning Goal: ${learningGoal}
- Preferred Track: ${track}
- Time Available Per Week: ${timePerWeek}
- Preferred Learning Depth: ${preferredDepth}
`.trim();

      // ── Shared preamble ────────────────────────────────────────────────────
      const PATIENCE_PREAMBLE = `IMPORTANT: Take your time. Think through the topic fully before writing any output. It is far better to produce one complete, accurate, well-structured response than to rush and produce something shallow or incomplete. Do not use placeholder text like "[TODO]" or "[expand here]". Every section must be fully written. If a topic is genuinely vast, cover the most critical parts completely and clearly state what can be explored next.`;

      // ── Build system prompt per mode ───────────────────────────────────────
      let systemPrompt;

      // ────────────────────────────────────────────────────────────────────────
      // MODE: roadmap
      // ────────────────────────────────────────────────────────────────────────
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

      // ────────────────────────────────────────────────────────────────────────
      // MODE: teach
      // ────────────────────────────────────────────────────────────────────────
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

      // ────────────────────────────────────────────────────────────────────────
      // MODE: project
      // ────────────────────────────────────────────────────────────────────────
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

      // ────────────────────────────────────────────────────────────────────────
      // MODE: research
      // ────────────────────────────────────────────────────────────────────────
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

      // ────────────────────────────────────────────────────────────────────────
      // MODE: assess
      // ────────────────────────────────────────────────────────────────────────
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

      // ── Call the AI ────────────────────────────────────────────────────────
      let aiResponse;
      try {
        aiResponse = await callAI(env.MBZUAI_API_KEY, systemPrompt, trimmedHistory, query);
      } catch (fetchErr) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: `Failed to reach AI API: ${fetchErr.message ?? String(fetchErr)}` }),
          { status: 502, headers: corsHeaders }
        );
      }

      if (!aiResponse.ok) {
        const errBody = await aiResponse.text().catch(() => "(unreadable)");
        return new Response(
          JSON.stringify({ status: "ERROR", message: `AI API returned HTTP ${aiResponse.status}. Details: ${errBody.slice(0, 400)}` }),
          { status: 502, headers: corsHeaders }
        );
      }

      let aiData;
      try {
        aiData = await aiResponse.json();
      } catch (_) {
        return new Response(
          JSON.stringify({ status: "ERROR", message: "AI API returned non-JSON response." }),
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

      // ── Extract structured output by tag ───────────────────────────────────
      const roadmapContent = extractTag(aiMessage, "roadmap");
      if (roadmapContent !== null) {
        return new Response(
          JSON.stringify({ status: "ROADMAP", mode: "roadmap", content: roadmapContent }),
          { status: 200, headers: corsHeaders }
        );
      }

      const lessonContent = extractTag(aiMessage, "lesson");
      if (lessonContent !== null) {
        return new Response(
          JSON.stringify({ status: "LESSON", mode: "teach", content: lessonContent }),
          { status: 200, headers: corsHeaders }
        );
      }

      const projectContent = extractTag(aiMessage, "project");
      if (projectContent !== null) {
        return new Response(
          JSON.stringify({ status: "PROJECT", mode: "project", content: projectContent }),
          { status: 200, headers: corsHeaders }
        );
      }

      const researchContent = extractTag(aiMessage, "research");
      if (researchContent !== null) {
        return new Response(
          JSON.stringify({ status: "RESEARCH", mode: "research", content: researchContent }),
          { status: 200, headers: corsHeaders }
        );
      }

      const assessmentContent = extractTag(aiMessage, "assessment");
      if (assessmentContent !== null) {
        return new Response(
          JSON.stringify({ status: "ASSESSMENT", mode: "assess", content: assessmentContent }),
          { status: 200, headers: corsHeaders }
        );
      }

      // ── Plain-text fallback ────────────────────────────────────────────────
      return new Response(
        JSON.stringify({ status: "COMPLETED", solution: aiMessage }),
        { status: 200, headers: corsHeaders }
      );

    } catch (err) {
      return new Response(
        JSON.stringify({ status: "ERROR", message: `Worker exception: ${err.message ?? String(err)}` }),
        { status: 500, headers: corsHeaders }
      );
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract content between <tagName> … </tagName>.
 * Finds the LAST occurrence of the opening tag so reasoning preamble
 * that accidentally contains the same tag name doesn't interfere.
 * If the closing tag is missing (truncated response), returns everything
 * after the opening tag so partial output is still usable.
 */
function extractTag(text, tagName) {
  const open  = `<${tagName}>`;
  const close = `</${tagName}>`;

  const startIdx = text.lastIndexOf(open);
  if (startIdx === -1) return null;

  const contentStart = startIdx + open.length;
  const endIdx = text.indexOf(close, contentStart);

  const raw = endIdx === -1
    ? text.slice(contentStart)
    : text.slice(contentStart, endIdx);

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Remove <think>…</think> reasoning blocks produced by chain-of-thought
 * models. Also handles models that emit reasoning before the final answer
 * without proper closing tags.
 */
function stripReasoning(raw) {
  // Remove well-formed <think> blocks
  let out = raw.replace(/<think>[\s\S]*?<\/think>/gi, "");

  // If a stray </think> is present, take only what comes after the last one
  if (out.includes("</think>")) {
    out = out.split("</think>").pop();
  }

  // If one of our structural tags exists, start from the last occurrence
  // to skip any reasoning preamble
  const structuralTags = ["<roadmap>", "<lesson>", "<project>", "<research>", "<assessment>"];
  let latestIdx = -1;
  for (const tag of structuralTags) {
    const idx = out.lastIndexOf(tag);
    if (idx > latestIdx) latestIdx = idx;
  }
  if (latestIdx !== -1) return out.slice(latestIdx).trim();

  return out.trim();
}

/**
 * Call the MBZUAI K2-Think model. Falls back to the alternate model ID
 * if the first attempt returns a non-2xx status.
 *
 * max_tokens: 16384 — keeps full responses on large teaching tasks.
 * temperature: 0.7  — balanced creativity and accuracy for education.
 */
async function callAI(apiKey, systemPrompt, history, userQuery) {
  const url = "https://api.k2think.ai/v1/chat/completions";
  const headers = {
    "Authorization": `Bearer ${apiKey.trim()}`,
    "Content-Type": "application/json",
  };

  const buildBody = (model) => JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      ...history,
      { role: "user", content: userQuery },
    ],
    temperature: 0.7,
    max_tokens: 16384,
    stream: false,
  });

  let res = await fetch(url, { method: "POST", headers, body: buildBody("MBZUAI/K2-Think-v2") });
  if (!res.ok) {
    res = await fetch(url, { method: "POST", headers, body: buildBody("MBZUAI-IFM/K2-Think-v2") });
  }
  return res;
}