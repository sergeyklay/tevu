/** The `PrerequisiteAdapter` contract, with the probe shape only it uses. */

import type { TevuResult } from '@/domain/errors';

/** Host platform and tool versions probed at the adapter boundary for the run manifest. */
export type HostProbe = {
  platform: 'linux' | 'darwin';
  nodeVersion: string;
  gitVersion: string;
};

/** Local prerequisite probes used by validation stages 3, 4, and 6. */
export interface PrerequisiteAdapter {
  probeHost(): Promise<TevuResult<HostProbe, 'PrerequisiteError'>>;
  hasEnvironmentVariable(name: string): boolean;
  probeWritableDirectory(directory: string): Promise<TevuResult<void, 'PrerequisiteError'>>;
}
