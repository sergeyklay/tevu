import { askConfirm, askText } from '@/interface/wizard-questions';
import { validateNonWhitespace } from '@/interface/wizard-validators';

import type { WizardIo } from '@/interface/wizard-questions';

/** Collects at least one readiness item, never sent to the agent. */
export async function interviewReadiness(io: WizardIo): Promise<string[]> {
  const items: string[] = [];
  for (;;) {
    const item = await askText(io, {
      message: 'Confirmed prerequisite',
      validate: validateNonWhitespace,
    });
    items.push(item);
    const wantsMore = await askConfirm(io, {
      message: 'Add another prerequisite?',
      initialValue: false,
    });
    if (!wantsMore) {
      return items;
    }
  }
}
