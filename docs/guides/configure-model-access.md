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

## Give the agent the model's prices

tevu reports cost only as the agent measures it, and never derives cost from token counts or model names. An agent that has no price for a model reports a cost of zero. When tevu can tell that no price stands behind that zero, it shows the cost as unavailable rather than as free, both for a case and for the grader; what tevu can tell depends on the agent. Tokens, time, and outcomes are still reported. The rule is in [Metrics](../reference/results.md#metrics).

So the price of every model you compare, and of the grader's model, has to be known to the agent. Where you set it depends on the agent.

### OpenCode

OpenCode prices a model from its provider definition. For a provider tevu copies from your OpenCode global configuration, add a `cost` object to each model under the provider's `models` map; tevu copies the prices into every case with the rest of the definition. A provider tevu does not copy needs no change here: its zero stays a measured `$0.0000`.

```json
{
  "provider": {
    "acme-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://your-proxy.example/v1" },
      "models": {
        "vendor/model-name": {
          "name": "Model name",
          "cost": {
            "input": 3,
            "output": 15,
            "cache_read": 0.3,
            "cache_write": 3.75
          }
        }
      }
    }
  }
}
```

`input` and `output` are required, and a model counts as priced only when both are numbers. `cache_read` and `cache_write` are optional. Prices are USD per 1 million tokens, the unit OpenCode's built-in model catalog uses. For a free model, set `input` and `output` to `0`, which makes its zero a measured one.

Take the prices from your provider or proxy. A LiteLLM proxy publishes per-token prices for each model in the `model_info` object returned by `GET /model/info`: `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, and `cache_creation_input_token_cost`. Multiply each by 1,000,000 to get the per-million value for `cost`. A model the proxy has no price for lacks these fields, so set the price from your provider's price list.

Afterward, run `tevu run` again. A saved run keeps the provider definition it copied, so earlier runs stay unavailable.

## Check that the model resolves

```sh
tevu validate
```

Validation lists the models the agent resolves and reports each model entry and role that is not among them. It also checks each `effort` against the variants OpenCode reports for its model. A listed model proves only that OpenCode declares it, not that the provider answers.

## Fix a failure

- **Model not available to the agent.** Compare the exact model identifier with the output of `opencode models` in your own shell. Add the provider as above, or declare the credential variable in `secrets` for a built-in provider.
- **A model only a repository's tracked `opencode.json` provides.** `tevu validate` cannot see it and reports it unresolved. Define the provider in `agents.opencode.providers` too.
- **Provider cannot be copied.** The finding names the value at fault. Reference a declared variable as `{env:NAME}` instead of writing a literal credential. For a credential header or an `env` entry, name a variable listed in `secrets`. Remove any `{file:...}` reference. Set `api_key` instead of writing `options.apiKey` by hand. The full rules are the [copy rules](../reference/agents-and-models.md#copy-rules).
- **Provider carries no credential warning.** Set `api_key` to a variable in `secrets` when the key lives in the login store. A provider that needs no key can ignore the warning.
- **Effort not among the model's variants.** Run `opencode models <provider> --verbose` in your own shell and read the model's `variants`. Set `effort` to a name listed there, or define the variant in the provider's definition in your OpenCode global configuration and copy that provider as above. A variant that only a task repository defines draws a warning for a model entry, because the listing runs in an empty repository. For a role, which runs without a repository, it is unsupported: an error for `roles.grader` when a task declares a graded check, otherwise a warning. See [Effort check](../reference/agents-and-models.md#effort-check).
- **Model listing failed or timed out.** Run `<command> models --verbose` yourself to see OpenCode's own diagnostic.
