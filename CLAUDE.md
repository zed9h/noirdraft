# Agent instructions for NoirDraft

## E2E tests must run headless (virtual display), not headed

Electron has no true headless mode — every `_electron.launch()` call opens a
real OS window. On this Linux development machine, that window opens on the
actual desktop and blocks the user from using their computer while tests run.

**Always run E2E tests through Xvfb, never directly:**

```sh
npm run test:e2e:virtual        # preferred: whole E2E suite, isolated virtual display
xvfb-run -a npx playwright test <file>   # preferred: a single spec file
```

**Never run these directly** (they open real, visible windows):

```sh
npm run test:e2e
npx playwright test ...
```

`npm run validate` also runs the suite headed via `npm run test:e2e` —
prefer running `npm test` and `xvfb-run -a npx playwright test` (or
`npm run test:e2e:virtual`) separately instead of `npm run validate` when
you need the E2E portion.

Only fall back to a real (non-Xvfb) headed run if a test is failing in a way
that seems specific to the virtual display itself (e.g., a genuine GPU/font
rendering difference) and you've confirmed Xvfb isn't the actual cause —
this should be rare, and even then prefer capturing a screenshot under Xvfb
first rather than watching a live window.
