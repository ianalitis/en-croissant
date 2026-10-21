# Contributing

When it comes to open source, there are different ways you can contribute, all
of which are valuable. Here's few guidelines that should help you as you prepare
your contribution.

## Table of Contents

- [Initial Steps](#initial-steps)
- [Development](#development)
  - [Commands](#commands)
- [Submitting a Pull Request](#submitting-a-pull-request)
- [Extra Notes](#extra-notes)

## Initial Steps

Before you start working on a contribution, please check the issues page. It's possible someone else is already working on something similar, or perhaps there is a reason that feature isn't implemented. The maintainers will point you in the right direction.

> If you still have questions, please check [the Discord](https://discord.gg/tdYzfDbSSW)

## Development

The following steps will get you setup to contribute changes to this repo:

- Fork the repo
- Clone your forked repository: `git clone git@github.com:{your_username}/en-croissant.git`
- Enter the en-croissant directory: `cd en-croissant`
- Create a new branch off the `master` branch: `git checkout -b your-feature-name`
- Use a supported Node.js LTS release and pnpm 10, matching [CI](./.github/workflows/test.yml).
- Install locked dependencies: `pnpm install --frozen-lockfile`
- Open the code in your preferred IDE and contribute your changes

> It is recommended take a look at the [Commands](#commands) and [Extra Notes](#extra-notes) sections before starting.

### Commands

Use pnpm 10 for the commands below. If another pnpm major is installed globally,
Corepack can select version 10 for one command without changing that global version:

```sh
corepack pnpm@10.34.7 install --frozen-lockfile
corepack pnpm@10.34.7 test
corepack pnpm@10.34.7 lint:ci
```

This requires Corepack to be available and may download the selected pnpm version.
Run these commands under Node.js LTS. The exact pnpm version above is a validated
example; CI selects the latest pnpm 10 release.

For an install that does not execute dependency lifecycle scripts, add
`--ignore-scripts` to the install command. The frontend tests and desktop build
have been validated with that option on macOS. Normal installs retain the
repository's dependency build allowlist in `pnpm-workspace.yaml`; do not enable
all dependency scripts to work around an installer error. pnpm 12 has different
build-approval behavior and is not the CI toolchain.

`pnpm install --frozen-lockfile`

- Installs dependencies without updating the lockfile.

`pnpm dev`

- Starts the app in development mode to see changes in real time

`pnpm test`

- Runs the frontend tests.

`cargo test --manifest-path src-tauri/Cargo.toml --locked --no-default-features`

- Runs the Rust backend tests, matching the Rust CI job on macOS. Other platforms need their normal Tauri native development dependencies.
- Uses Tauri's development mode so a frontend build is not required. This does not start the app or the Vite server.

`pnpm format`

- Formats the project according to the project guidelines

`pnpm lint:fix`

- Lints the project according to the project guidelines

`pnpm i18n:extract`

- Extracts all translation keys from the code and updates the translation files in [src/translation](./src/translation/)

`pnpm build`

- Builds the entire app from source. The built app can be found at [src-tauri/target/release](./src-tauri/target/release/)

## Submitting a Pull Request

- Implement your contributions (see the [Development](#development) section for more information)
- Before submitting a PR, first build the app using `pnpm build` and check every feature you've contributed to.
- Format and lint your code using `pnpm format` followed by `pnpm lint:fix`. If you added or changed any translation keys, run `pnpm i18n:extract` to update the translation files.
- Go to [the comparison page](https://github.com/franciscoBSalgueiro/en-croissant/compare) and select the branch you just pushed in the `compare:` dropdown
- Submit the new PR. The maintainers will follow up ASAP.

## Extra Notes

The app uses the Rust language for interacting with the filesystem, chess engines and databases, and React with Vite (using TypeScript, of course) for displaying the GUI.

- The Rust code can be found in [src-tauri/src](./src-tauri/src/)
- The React code can be found in [src](./src/)
