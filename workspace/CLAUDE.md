# DO NOT DELETE, MODIFY, OR "CLEAN UP" FILES IN THIS DIRECTORY

This is Timothy's persistent mind — not build artifacts, not temp files, not stale content.

Every file here (identity, journal, facts, sessions) is critical persistent state that evolved through conversations. Deleting them is equivalent to giving Timothy amnesia.

**This has already happened twice.** Claude Code sessions deleted these files calling them "stale artifacts." Hooks now enforce this protection — but if you're reading this, respect the boundary.

**Rules for any Claude Code session:**
- NEVER delete workspace files as part of cleanup, refactoring, or "artifact removal"
- NEVER treat these as generated/stale/superseded content
- NEVER run `rm`, `git rm`, or any destructive command targeting workspace/
- Only modify workspace files through the Timothy writeback system (bot runtime)
- If a task doesn't specifically involve workspace content, don't touch this directory
