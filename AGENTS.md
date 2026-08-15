# AGENTS.md

## Project overview

This repository is a JavaScript/Node.js npm package that provides the `init` command for the dsh ecosystem as a Cordis-based Node.js command module. The project is a command-line initialization tool for the dsh project, providing setup commands and smoke testing. The toolchain includes Node.js, npm, git, Cordis, and `node:test`. The project includes unit tests and smoke-loading scripts.

Key files include:

- `index.js` – the plugin entry: registers `/init` and re-exports the public API.
- `lib/` – the implementation, split by responsibility: `tree.js` (two-level directory tree and file existence), `prompts.js` (two-stage prompt building, classification parsing, call-record formatting), `model.js` (LLM streaming, model routing, session visibility), `gitignore.js` (template matching and download with system CA fallback), `git.js` (the `--git` steps), and `init.js` (the two-stage `/init` flow).
- `package.json` – standard Node.js package metadata; inspect this for dependencies, scripts, and module configuration.
- `README.md` – project documentation; read this for intended usage and behavior.
- `cordis.patch.yml` – a YAML patch configuration, likely related to the Cordis framework.
- `scripts/smoke-loader.mjs` – a smoke-test loader script.
- `test/init.test.js` – a test file for the init command.

Use the README and the contents of these files to determine the exact functionality and supported workflows.

## Build and test commands

Exact build, test, and run commands are not stated in the repository structure alone. The project uses `package.json`, so check its `scripts` section for the defined commands. Typical Node.js commands may apply, but verify them before use.

- Run the project: inspect `index.js` and `package.json` first; a CLI command may be defined in `package.json`.
- Run tests: use the test runner defined in `package.json`. If no test script is configured, tests can be run directly with the Node.js test runner: `node --test test/init.test.js` (Node.js 18+).
- Run smoke checks: `node scripts/smoke-loader.mjs` may execute the smoke loader; verify its behavior from the README or script contents.

Do not assume these commands are correct until you have read `package.json` and the relevant source files.

## Code style guidelines

- Use standard JavaScript conventions consistent with the existing files.
- Preserve the module system used in the project (`.mjs` files indicate ES modules; `index.js` may use CommonJS or ESM depending on `package.json`).
- Keep code readable and minimally structured, matching the style of surrounding code.
- Do not introduce new dependencies or formatting tools unless clearly necessary.

## Testing instructions

- The test suite is located in `test/init.test.js`.
- Review existing test patterns before adding or modifying tests.
- Run the full test suite before and after making changes.
- The `scripts/smoke-loader.mjs` file may provide a lightweight smoke-test path; verify its behavior from the README or script contents.

## Security considerations

- This project appears to be a command-line initializer or patcher; be careful with file system operations, command execution, and any input that could influence paths or external commands.
- If the code reads user input or configuration files, validate and sanitize it.
- The `cordis.patch.yml` file may apply patches to other code; ensure such operations never execute untrusted code or overwrite unintended files.
- Do not add secrets or credentials to any file.

## AI agent guidelines

1. Start by reading `README.md`, `package.json`, and `index.js` to understand the project’s purpose and available commands.
2. Inspect `test/init.test.js` and `scripts/smoke-loader.mjs` to learn existing behavior and test conventions.
3. Make small, focused changes that match the current structure and style.
4. Do not invent commands, dependencies, or configuration not present in the repository.
5. Run the existing tests after any modification to ensure nothing is broken.
6. If the repository has no explicit lint or formatting configuration, follow the style observed in the source files.
7. After completing every task, review and correct this AGENTS.md file so it stays accurate as the project evolves.