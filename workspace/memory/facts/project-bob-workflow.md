---
subject: project-bob
topic: development-workflow
confidence: stated
date: 2026-02-27
---

The `.bob/` directory structure organizes development work through a defined pipeline: ideate, intent, implementation, features, stories, waves, code, test, verify, commit. Intent plans capture what and why. Implementation plans capture how, with date-prefixed filenames. Features decompose into stories with Gherkin acceptance criteria. Waves group stories for parallel execution. Each artifact compresses the previous step into a focused document that can seed a fresh session. The workflow is managed by Titus through the `/bob` skill, with individual steps handled by specialized skills (`/features`, `/stories`, `/wave`, `/commit`).
