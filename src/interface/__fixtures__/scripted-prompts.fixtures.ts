type AskOptions = {
  message: string;
  placeholder?: string;
  defaultValue?: string;
  initialValue?: unknown;
  options?: Array<{ value?: unknown; label?: string; hint?: string; disabled?: boolean }>;
  signal?: AbortSignal;
  statusLine?: unknown;
  validate?: (value: string | undefined) => string | undefined;
  onCancel?: (typed: string) => void;
};

export const clack = (() => {
  const CANCEL = Symbol('clack-cancel');
  const ESCAPE = Symbol('clack-escape');
  const state = {
    prompts: [] as Array<{
      kind: string;
      message: string;
      placeholder: string | undefined;
      defaultValue: string | undefined;
      initialValue: unknown;
      /** The label of the option a select question opens on. */
      initialLabel: string | undefined;
      options: Array<{ label: string; hint: string | undefined; disabled: boolean }> | undefined;
    }>,
    notes: [] as Array<{ message: string; title: string | undefined }>,
    logs: [] as Array<{ kind: string; message: string }>,
    rejections: [] as Array<{ kind: string; message: string; reason: string }>,
    answers: [] as unknown[],
    cancels: [] as string[],
    outros: [] as string[],
    spinners: [] as Array<{ label: string; handleSignals: boolean | undefined }>,
    timeline: [] as string[],
    statusLines: [] as Array<{ message: string; statusLine: unknown }>,
    sectionedSelects: [] as Array<{
      message: string;
      sections: ReadonlyArray<{
        heading?: string;
        options: ReadonlyArray<{ value: string; label: string }>;
      }>;
      back: { value: string; label: string };
    }>,
  };
  const isInvalidMarker = (value: unknown): value is { invalid: string } =>
    typeof value === 'object' && value !== null && 'invalid' in value;
  const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;
  const isInterruption = (value: unknown): value is () => void => typeof value === 'function';
  const isTypedCancel = (value: unknown): value is { cancelTyped: string } =>
    typeof value === 'object' && value !== null && 'cancelTyped' in value;
  const isLabelPick = (value: unknown): value is { pickLabel: string } =>
    typeof value === 'object' && value !== null && 'pickLabel' in value;
  /** A scripted choice at a select question, named by the label of the option it takes. */
  const pickLabel = (label: string): { pickLabel: string } => ({ pickLabel: label });
  /** A scripted Ctrl-C at a text question that holds `typed`, reported through `onCancel` first. */
  const cancelTyped = (typed: string): { cancelTyped: string } => ({ cancelTyped: typed });
  const applyDefault = (kind: string, options: AskOptions, answer: unknown): unknown =>
    kind === 'text' && answer === '' && options.defaultValue !== undefined
      ? options.defaultValue
      : answer;
  const ask = async (kind: string, options: AskOptions): Promise<unknown> => {
    let isEscapeConsumed = false;
    for (;;) {
      if (!isEscapeConsumed) {
        state.prompts.push({
          kind,
          message: options.message,
          placeholder: options.placeholder,
          defaultValue: options.defaultValue,
          initialValue: options.initialValue,
          initialLabel: options.options?.find((option) => option.value === options.initialValue)
            ?.label,
          options: options.options?.map((option) => ({
            label: option.label ?? '',
            hint: option.hint,
            disabled: option.disabled === true,
          })),
        });
        state.statusLines.push({ message: options.message, statusLine: options.statusLine });
        state.timeline.push(`prompt:${options.message}`);
      }
      isEscapeConsumed = false;
      if (isAborted(options.signal)) {
        return CANCEL;
      }
      const answer = state.answers.shift();
      if (answer === undefined) {
        throw new Error(`no scripted answer left for ${kind}: ${options.message}`);
      }
      if (answer === ESCAPE) {
        isEscapeConsumed = true;
        continue;
      }
      if (isTypedCancel(answer)) {
        options.onCancel?.(answer.cancelTyped);
        return CANCEL;
      }
      if (isLabelPick(answer)) {
        const picked = options.options?.find((option) => option.label === answer.pickLabel);
        if (picked === undefined) {
          throw new Error(`no option labelled "${answer.pickLabel}" at ${options.message}`);
        }
        return picked.value;
      }
      if (isInterruption(answer)) {
        answer();
        if (isAborted(options.signal)) {
          return CANCEL;
        }
        continue;
      }
      if (isInvalidMarker(answer)) {
        const reason = options.validate?.(answer.invalid);
        if (reason !== undefined) {
          state.rejections.push({ kind, message: options.message, reason });
          continue;
        }
        return applyDefault(kind, options, answer.invalid);
      }
      return applyDefault(kind, options, answer);
    }
  };
  return { CANCEL, ESCAPE, cancelTyped, pickLabel, state, ask };
})();

export const clackPromptsModule = (() => {
  const recordLog = (kind: string, message: string): void => {
    clack.state.logs.push({ kind, message });
    clack.state.timeline.push(`log:${kind}`);
  };
  return {
    multiselect: (options: AskOptions) => clack.ask('multiselect', options),
    intro: (message: string) => {
      clack.state.prompts.push({
        kind: 'intro',
        message,
        placeholder: undefined,
        defaultValue: undefined,
        initialValue: undefined,
        initialLabel: undefined,
        options: undefined,
      });
      clack.state.timeline.push('intro');
    },
    outro: (message: string) => {
      clack.state.outros.push(message);
      clack.state.timeline.push('outro');
    },
    cancel: (message: string) => {
      clack.state.cancels.push(message);
      clack.state.timeline.push('cancel');
    },
    note: (message: string, title?: string) => {
      clack.state.notes.push({ message, title });
    },
    log: {
      info: (message: string) => {
        recordLog('info', message);
      },
      warn: (message: string) => {
        recordLog('warn', message);
      },
      step: (message: string) => {
        recordLog('step', message);
      },
      message: (message: string) => {
        recordLog('message', message);
      },
      success: (message: string) => {
        recordLog('success', message);
      },
    },
    isCancel: (value: unknown) => value === clack.CANCEL,
  };
})();

export const wizardPromptsModule = {
  text: (options: AskOptions) => clack.ask('text', options),
  confirm: (options: AskOptions) => clack.ask('confirm', options),
  select: (options: AskOptions) => clack.ask('select', options),
};

export const sectionedSelectModule = {
  sectionedSelect: async (options: {
    message: string;
    sections: (typeof clack.state.sectionedSelects)[number]['sections'];
    back: { value: string; label: string };
    signal?: AbortSignal;
    statusLine?: unknown;
  }): Promise<unknown> => {
    const isAborted = (): boolean => options.signal?.aborted === true;
    clack.state.statusLines.push({ message: options.message, statusLine: options.statusLine });
    clack.state.sectionedSelects.push({
      message: options.message,
      sections: options.sections,
      back: options.back,
    });
    for (;;) {
      clack.state.timeline.push(`prompt:${options.message}`);
      if (isAborted()) {
        return clack.CANCEL;
      }
      const answer = clack.state.answers.shift();
      if (answer === undefined) {
        throw new Error(`no scripted answer left for sectionedSelect: ${options.message}`);
      }
      if (answer === clack.ESCAPE) {
        return options.back.value;
      }
      if (typeof answer === 'function') {
        answer();
        if (isAborted()) {
          return clack.CANCEL;
        }
        continue;
      }
      return answer;
    }
  },
};

export const yoctoSpinnerModule = {
  default: (options: { text?: string; handleSignals?: boolean }) => {
    const label = (options.text ?? '').trim();
    clack.state.spinners.push({ label, handleSignals: options.handleSignals });
    return {
      start: () => {
        clack.state.timeline.push(`spinner:start:${label}`);
      },
      stop: () => {
        clack.state.timeline.push(`spinner:stop:${label}`);
      },
    };
  },
};

export const stdinDiscarderModule = {
  default: {
    start: () => {
      clack.state.timeline.push('discarder:start');
    },
    stop: () => {
      clack.state.timeline.push('discarder:stop');
    },
  },
};

export function scriptAnswers(...answers: unknown[]): void {
  clack.state.answers.push(...answers);
}

/** The events after the wait `label` ends, without the stdin discarder's stop. */
export function eventsAfterWait(label: string): string[] {
  return clack.state.timeline
    .slice(clack.state.timeline.lastIndexOf(`spinner:stop:${label}`) + 1)
    .filter((event) => event !== 'discarder:stop');
}

export function removalWarnings(): { kind: string; message: string }[] {
  return clack.state.logs.filter((log) => log.message.startsWith("Couldn't remove"));
}

export function resetClackState(): void {
  clack.state.prompts = [];
  clack.state.notes = [];
  clack.state.logs = [];
  clack.state.rejections = [];
  clack.state.answers = [];
  clack.state.cancels = [];
  clack.state.outros = [];
  clack.state.spinners = [];
  clack.state.timeline = [];
  clack.state.sectionedSelects = [];
  clack.state.statusLines = [];
}
