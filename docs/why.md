# Why This Exists

I've been building things since junior high — first Arduino sketches, now PCBs and trading systems. AI is part of my toolkit and my learning loop: I think with Opus 4.6 (planner/debater by nature), execute with Sonnet 5 + Opus 4.8 (strict prompt-followers, built to ship), and cross-check across Gemini, Copilot, and Codex before anything lands.

Each model has a job that matches how it was trained:

- **Think** — Opus 4.6 @ claude.ai holds my personal memory, debates approaches, and stress-tests plans before I commit. Its training leans toward reasoning and nuance — exactly what planning needs.
- **Execute** — Sonnet 5 writes the code; Opus 4.8 reviews as advisor. Both are trained for strict prompt-following and precise output — they ship, not philosophize.
- **Cross-check** — `consult` fans out to Copilot, Codex, and Gemini in parallel. Different training data, different blind spots, independent verdicts. No single model gets the last word.
- **Iterate** — everything feeds back to me. I synthesize, decide, and kick off the next cycle. The human stays in the loop at every gate.

Beyond model selection, each delegation gets a **role prompt** — "As a Security auditor…", "As a Frontend engineer…", "As a Karpathy-style code reviewer…" — so the model responds from a specific expertise frame, not as a generic assistant. I maintain a full role table (20+ roles across engineering, product, content, and research) that maps each role to the right model tier and tool.

The bridges are the plumbing that makes cross-checking programmatic — not manual copy-paste between chat windows.
