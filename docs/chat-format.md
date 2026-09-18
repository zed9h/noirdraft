# NoirDraft CHAT convention

CHAT remains ordinary Markdown. The application recognizes headings for navigation but does not require a rigid conversation database.

The default convention is:

````markdown
# 2026-09-18 — Chapter 3 / Maria

## User

This reaction explains too much.

## Agent

The second sentence states the emotion explicitly.

## User

Rewrite it without naming the emotion.
````

In the complete project file these headings are stored one level deeper beneath `# CHAT`. A top-level visible heading groups a writing task; `## User` and `## Agent` distinguish participants. Authors may freely create other heading structures for brainstorming or general notes. CHAT is stored history, not an instruction to replay every conversation into model context.
