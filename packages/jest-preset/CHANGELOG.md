# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.6.0](https://github.com/proteinjs/build/compare/@proteinjs/jest-preset@1.5.0...@proteinjs/jest-preset@1.6.0) (2026-11-10)


### Bug Fixes

* **jest-preset:** the stripper's words end at whitespace — `1⏎return /'/` is `return` then a regex literal (ASI), never `1return` then a division whose quote swallows the line; the keyword road (`return` / `typeof` before a `/`) pinned by two guards ([2a4967a](https://github.com/proteinjs/build/commit/2a4967a84903d39d61e368efb31a94cf7b5e3ad4))


### Features

* **jest-preset): the judge names a config that reads or writes the process (P1, by line — process.env written, NODE_OPTIONS / process.argv / process.execArgv read, process.exit; in the config and in the local modules the caller hands in as `modules`, `localRequires` naming them; thought-export's round-1 seam is the pin's fixture) and the declaration gets ONE reader every consumer shares — knobs.declaration(packageDir) / knobs.nodeOptions(packageDir:** the builder's own read and the land tool's (`land reds` starts node under the declared flags); knobs.d.ts ships, practice.d.ts carries the new surface ([f40b0de](https://github.com/proteinjs/build/commit/f40b0de892bbbeb1fcc627ff973d98ea041bf515))
* **jest-preset:** the judge names the process held as a VALUE — a bare `process.env` (no key after it) and a bare `process` (no member) are P1 reads, so `const { env } = process` / `const e = process.env` read as the write they alias — and ONE tokenizing stripper replaces the two the file carried (strings, templates, comments and regex literals in one pass: a regex's `//` is no comment, its quote opens no string, a template's ${…} is code; stripComments folded into blank, positions kept) ([0d535ec](https://github.com/proteinjs/build/commit/0d535ecc02618ef1684fff3578bd0773a6c0ceb0))
* **jest-preset:** the judge reads an object literal spread IN PLACE as the package's own writing (`...{ maxWorkers: 2 }` names maxWorkers; nested in-place spreads the same) while an expression spread (`...fragment`) stays the fragment owner's — the spread read now moves judge()'s verdict, so the P4 bite reds on the outcome ([5782d58](https://github.com/proteinjs/build/commit/5782d58cf0b8aa44a8e1c793bb0169cff2ab4917))
* **jest-preset:** the node-options declaration (package.json jestPreset.nodeOptions with its reason — the builder joins each flag to NODE_OPTIONS at config load for the forked workers and refuses an in-process run that lacks it, by name with the command that carries it; the judge reads it as practice) and the worker default is the physical cores (knobs.workers: JEST_WORKERS unset → floor(os.availableParallelism() / 2), never jest's cpus − 1 — DECISIONS 764's measurement; the local advisory a ceiling through the preset); the declaration's vocabulary is closed, a key outside it refused by name ([5b4a5a9](https://github.com/proteinjs/build/commit/5b4a5a9cc8b09bfb05fabfcb6da78fe0e4015782))





# [1.5.0](https://github.com/proteinjs/build/compare/@proteinjs/jest-preset@1.4.0...@proteinjs/jest-preset@1.5.0) (2026-11-07)


### Features

* **jest-preset:** the practice's judge ships with the preset (practice.js — @proteinjs/jest-preset/practice: a pure read of package.json + jest.config.js naming each deviation from P1–P3, the exported object literal read in any layout) and ts-jest's one floor (TS_JEST_FLOOR — the builder refuses below it, the peer range states it) ([89bf648](https://github.com/proteinjs/build/commit/89bf648f36997353f5b82979474ca978bcd56e29))





# [1.4.0](https://github.com/proteinjs/build/compare/@proteinjs/jest-preset@1.3.0...@proteinjs/jest-preset@1.4.0) (2026-11-07)


### Features

* **jest-preset:** the in-band declaration (package.json jestPreset.inBand) and the one CI test practice stated whole ([15a0946](https://github.com/proteinjs/build/commit/15a0946ec6374982788aa32b5570655c8cc9cbd1))
* **jest-preset:** the TypeScript floor for Node16 / NodeNext packages, named at config load ([1b910b8](https://github.com/proteinjs/build/commit/1b910b815014f8e7afe41bd6186fef32794d590f))





# [1.3.0](https://github.com/proteinjs/build/compare/@proteinjs/jest-preset@1.2.0...@proteinjs/jest-preset@1.3.0) (2026-09-30)


### Features

* **jest-preset:** testTimeoutForBackend — the per-test clock derived from the database driver's operation deadline ([ae294a0](https://github.com/proteinjs/build/commit/ae294a0f659cb5ffdddba760b8320cea7b3f2d37))





# [1.2.0](https://github.com/proteinjs/build/compare/@proteinjs/jest-preset@1.1.0...@proteinjs/jest-preset@1.2.0) (2026-08-31)


### Features

* local estate machinery (RESOURCE_GOVERNANCE §B) — registry, reaper, pressure valve, docker guardianship ([c1fa259](https://github.com/proteinjs/build/commit/c1fa2591e7a0aa62c974a960cf0ca351ddfcd08f))





# 1.1.0 (2026-08-25)


### Features

* @proteinjs/jest-preset — the shared jest preset (DEV_INFRA_PLAN §13.6 centralization ruling: test config inherited, never repeated) ([f14963b](https://github.com/proteinjs/build/commit/f14963be4007dfaeaa09bf8d9e45477647d46547))
