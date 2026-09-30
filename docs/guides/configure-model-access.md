# Make a model reachable

Give the benchmarked agent access to a model whose provider you configured in OpenCode, or to a built-in provider.

A case agent runs with its own home, so credentials stored only in your usual agent login are not available to it. You declare what crosses.

## For a built-in provider

Export the provider's credential variable in the terminal that launches tevu, and list its name in `agents.opencode.secrets`:

```yaml
agents:
  opencode:
    command: opencode
    secrets:
      - OPENAI_API_KEY
```

## For a provider from your OpenCode configuration

List the provider's ID from the `provider` map of your OpenCode global configuration in `agents.opencode.providers`. When the provider's key lives in the OpenCode login store, set `api_key` to a variable in `secrets`:

```yaml
agents:
  opencode:
    command: opencode
    secrets:
      - ACME_KEY
    providers:
      - id: acme-proxy
        api_key: ACME_KEY
```

The `tevu task add` setup interview does this for you when it finds the provider in your configuration. See [Providers](../reference/agents-and-models.md#providers) for how tevu reads and copies the definition.

## Check that the model resolves

```sh
tevu validate
```

Validation lists the models the agent resolves and reports each model entry and role that is not among them. A listed model proves only that OpenCode declares it, not that the provider answers.

## Fix a failure

- **Model not available to the agent.** Compare the exact model identifier with the output of `opencode models` in your own shell. Add the provider as above, or declare the credential variable in `secrets` for a built-in provider.
- **A model only a repository's tracked `opencode.json` provides.** `tevu validate` cannot see it and reports it unresolved. Define the provider in `agents.opencode.providers` too.
- **Provider cannot be copied.** The finding names the value at fault. Reference a declared variable as `{env:NAME}` instead of writing a literal credential. For a credential header or an `env` entry, name a variable listed in `secrets`. Remove any `{file:...}` reference. Set `api_key` instead of writing `options.apiKey` by hand. The full rules are the [copy rules](../reference/agents-and-models.md#copy-rules).
- **Provider carries no credential warning.** Set `api_key` to a variable in `secrets` when the key lives in the login store. A provider that needs no key can ignore the warning.
- **Model listing failed or timed out.** Run `<command> models` yourself to see OpenCode's own diagnostic.
