# Contributing to Cardlake

Thanks for taking a look at Cardlake.

**Issues are welcome; pull requests aren't accepted.** Report bugs and suggest features through the issue templates. Cardlake has a single maintainer, and every change is written by them, so please don't open a pull request: it will be closed without review. If you'd like something changed, open an issue describing it instead.

You're free to change your own copy as you like. The rest of this doc covers running it locally and testing your changes.

## Setup

```bash
git clone https://github.com/cardleforall/cardlakeforall.git
cd cardlakeforall
npm ci
cp .env.example .env.local   # fill in real values -- see docs/ENVIRONMENT.md
npm run dev
```

`docs/ENVIRONMENT.md` explains what each variable does. Point `DATABASE_URL` at a database of your own (a free Neon project is enough): it is used exactly as configured, so never point it at one that holds real data.

## Testing a change

1. **Run the build check**: `npm test` (this runs `build:vault` + `validate:vault`).
2. **Run the right test tier**: `npm run test:lite` covers the offline unit suite and is required for every change. If your change touches `api/`, `schema-v2.sql`, or anything else database-adjacent, also run `npm run test:full`; see [tests/README.md](tests/README.md) for the full tier breakdown and why `lite` alone has missed real bugs before.
3. **Keep changes scoped**: one commit per logical change.

## Code style

There's no linter enforced yet: match the conventions already in the file you're editing (this codebase leans toward small, well-named functions and comments that explain *why*, not *what*).

## Reporting bugs / requesting features

Please use the issue templates. They ask for the specific details (repro steps, environment, expected vs. actual) that make a bug fixable without a back-and-forth.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). Be respectful; disagreements about code are fine, personal attacks aren't.

## License

Cardlake is licensed under the [GNU AGPL-3.0](LICENSE). If you run a changed copy as a service for other people, the license requires you to offer them its source.
