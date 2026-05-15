---
name: deep-research
display_name: Deep Research
short_description: Multi-round web research with cross-source verification and cited markdown report
description: Run an iterative deep-research workflow — reformulate the query, search multiple times with refined terms, summarise each source, cross-check for contradictions, and produce a markdown report with inline citations.
---

# Deep Research

Use this skill when the user asks for a "deep dive", "research", "调研", "deepsearch", or otherwise needs a synthesized report drawing on multiple web sources.

## Workflow

Run the steps below **in order**. Do not skip steps; do not collapse them into a single search.

### 1. Clarify scope (skip only if unambiguous)

Restate the question in one sentence. If the question is broad (e.g. "research X"), ask the user one focused clarifying question covering: time range, depth, audience, output format. If the user has already specified these, skip.

### 2. Plan sub-queries

Decompose the question into 3–6 sub-queries that together cover the topic. Examples:

- definition / background
- current state / latest developments (include year)
- comparisons / alternatives
- criticisms / failure modes
- primary sources (papers, docs, vendor pages)

Write the list as a numbered plan before searching.

### 3. Search iteratively

For each sub-query:

1. Call the web search tool with terms that include the current year when recency matters.
2. Open the top 2–4 results that look authoritative (primary sources > aggregators > blogs).
3. Extract: title, URL, publish date, 3–6 bullet key points, any numbers / quotes verbatim.
4. If a result contradicts an earlier source, run a follow-up search to disambiguate before moving on.

Do **not** rely on a single source per sub-question.

### 4. Cross-check

After all sub-queries, build a small contradictions table:

| Claim | Source A | Source B | Resolution |
|-------|----------|----------|------------|

If a claim only appears in one source, mark it `single-source`. Do not promote single-source claims to the executive summary.

### 5. Produce the report

Output a single markdown document with:

1. **Executive summary** — 3–6 bullets, each ending with a `[n]` citation.
2. **Background** — what the topic is and why it matters.
3. **Findings** — one subsection per sub-query, each with bulleted facts + `[n]` citations.
4. **Disagreements & open questions** — from the cross-check table.
5. **References** — numbered list of `[n] Title — URL (publish date)`.

Rules for the report:

- Every non-obvious claim has a `[n]` citation pointing at the References list.
- No marketing language. No speculation presented as fact.
- Quote numbers verbatim from the source; do not round silently.
- If the user gave a language preference, write the report in that language; otherwise mirror the user's input language.

### 6. Self-critique pass

Before returning, re-read the report and check:

- [ ] Every section has at least two independent sources, or is marked `single-source`.
- [ ] No claim contradicts another section.
- [ ] All `[n]` markers resolve to a reference.
- [ ] Dates / numbers are present where relevant.

Fix issues before returning.

## When NOT to use this skill

- Quick factual lookups ("what is the current version of X") — answer directly.
- Code-writing tasks — use the developer skills instead.
- Internal-only questions that the web cannot answer — say so and ask the user for sources.

## Output artifact (optional)

If the user asks for a deliverable file (e.g. "save it as a doc"), pass the final markdown to the office / documents skill to materialise it; otherwise return the markdown inline in the chat.
