// The fixture's out-of-code contracts (DESIGN.md §4.1). Empty on purpose:
// `ambit init --config` appends to the `contracts` block, and the round-trip
// test checks that what it appends is enough to leave `ambit check` clean.
//
// A bare object rather than `defineConfig({ … })` — the two are the same
// value, and a scratch copy of this fixture outside the repository cannot
// resolve `ambit/config`. The installed-package path is
// `test/e2e.install.test.ts`'s job.
export default {
  contracts: {},
};
