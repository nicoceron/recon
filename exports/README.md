# Local exports

This directory intentionally contains no captures in Git. Generated reconstruction packages can be large and may contain captured site or session data, so every item here except this note is ignored.

Create an export locally from the repository root:

```bash
npm install
npm run dev -- export https://example.com/ --no-serve
```

Then give the reconstruction agent the absolute path to the complete generated directory, such as `exports/example-export/`, and tell it to read `LLM_HANDOFF.md` first. The Markdown file is only the entry point; the neighboring screenshots, assets, fonts, DOM, CSS, and JSON evidence are also required.

For the cross-repository workflow, see [`../RECONSTRUCTION_AGENT.md`](../RECONSTRUCTION_AGENT.md).
