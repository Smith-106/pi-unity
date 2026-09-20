# Attribution

This fork of [aefreedman/pi-unity](https://github.com/aefreedman/pi-unity) bundles the
official Unity agent skills alongside pi-unity's own skills, making it a single
**engine + knowledge** plugin for [pi](https://github.com/earendil-works/pi-coding-agent).

## Two licensing domains

### Engine & pi-unity skills — MIT

All TypeScript under `index.ts`, `src/`, `tests/`, `evals/`, plus the pi-unity-authored
skills (`auditing-unity-agent-guidance`, `unity-batchmode-tests`, `unity-debugging`,
`unity-interactive-playmode-authoring`, `unity-pipeline-workflows`), are © Aaron Freedman
and licensed under the **MIT License** — see [LICENSE](LICENSE).

### Official Unity skills — Unity Companion License

The 31 skills under `skills/` copied verbatim from
[Unity-Technologies/unity-agent-plugin](https://github.com/Unity-Technologies/unity-agent-plugin)
(e.g. `implement-in-app-purchases`, `levelplay-unity-integration`, `migrate-birp-to-urp`,
`tilemap-*`, `ui-*`, `unity-cli`, `unity-package-management`, `physics-3d-collision`, …) are
© Unity Technologies and licensed under the **Unity Companion License** — see
[LICENSE-Unity.md](LICENSE-Unity.md). Their content is unchanged.

### unity-cli skill note

`unity-cli` documents the official `unity` binary. Its `--caller plugin --skill <name>`
convention still applies when an agent invokes it through these skills.
