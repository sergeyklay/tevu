# Install tevu

Build tevu from a checkout and put the `tevu` command on your `PATH`.

You need Linux or macOS with Node.js 24, Bun, and Git. The benchmarks in the next tutorial also need OpenCode installed.

## 1. Build the executable

From your tevu checkout:

```sh
bun install --frozen-lockfile
bun run build
```

The build writes `dist/index.js`, the only supported way to run tevu.

## 2. Link the command

```sh
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/index.js" ~/.local/bin/tevu
```

`~/.local/bin` must be on your `PATH`. Any directory on `PATH` works. The link points into the checkout, so the checkout must stay where it is.

## 3. Check that it runs

```sh
tevu --help
```

You should see the list of commands: `task`, `validate`, `run`, `assess`, `report`, and `config`. If the shell cannot find `tevu`, add the link's directory to `PATH`.

`tevu` runs with the `node` found on `PATH`, so Node.js 24 must be the `node` in every directory where you use tevu.

After you update the checkout, repeat step 1. The link keeps pointing at the rebuilt file.

## Next

[Run your first comparison](first-comparison.md).
