# NoirDraft

NoirDraft is an early-stage Electron application for writing fiction in one transparent Markdown project file. `PLAN.md` is the product and architecture plan; `TODO.md` tracks phased implementation evidence.

## Development

Requires Node.js 22 or newer.

```sh
npm install
npm start
```

## Verification

```sh
npm test
npm run test:e2e
npm run test:e2e:virtual # Linux: isolated virtual display; does not open desktop windows
npm run validate
```

The E2E suite launches the real Electron runtime. On Linux, use `test:e2e:virtual` to keep its windows off the active desktop.

See `docs/release-audit.md` for the runbook covering what still needs a real Windows machine, a human IME tester, and sustained real-world usage before a first release — everything else is already implemented and automatically tested.
