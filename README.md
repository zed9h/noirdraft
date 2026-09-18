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

The E2E suite launches the real Electron runtime. On Linux, use `test:e2e:virtual` to keep its windows off the active desktop. Phase 1 must validate EditContext selection and IME correctness before work advances to later application systems.
