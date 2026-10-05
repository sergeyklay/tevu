# Install tevu

Install the `tevu` package from npm and check that the `tevu` command runs.

You need Linux or macOS with Node.js 24, npm, and Git. npm ships with Node.js. The benchmarks in the next tutorial also need OpenCode installed.

## 1. Install the package

```sh
npm install --global tevu
```

npm puts the `tevu` command in the `bin` directory of its global prefix. Run `npm prefix --global` to see the prefix; its `bin` directory must be on your `PATH`.

If npm fails with `EACCES`, your global prefix is not writable by your user. Don't rerun the command with `sudo`. Install Node.js with a Node.js version manager, or point npm at a directory you own; npm describes both in [Resolving EACCES permissions errors when installing packages globally](https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally/).

## 2. Check that it runs

```sh
tevu --version
tevu --help
```

`tevu --version` prints the installed version. `tevu --help` lists the commands: `task`, `validate`, `run`, `assess`, `report`, and `config`. If the shell cannot find `tevu`, add the `bin` directory of the npm global prefix to `PATH`.

`tevu` runs with the `node` found on `PATH`, so Node.js 24 must be the `node` in every directory where you use tevu.

## Update

```sh
npm install --global tevu@latest
```

## Try a prerelease

Release candidates are published to the `next` channel. `npm install --global tevu` installs from `latest` and never picks them up, so name the channel:

```sh
npm install --global tevu@next
```

To go back to the stable release, run the update command above.

## Uninstall

```sh
npm uninstall --global tevu
```

tevu leaves your configuration file and saved runs in place.

## Next

[Run your first comparison](first-comparison.md).

To work on tevu itself, see [CONTRIBUTING.md](../../CONTRIBUTING.md).
