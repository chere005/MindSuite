/** One hook for "may this ledger be edited here", and what to say about where it came from. */
import { useEffect, useState } from 'react';
import type { LedgerAccess, SyncInfo } from '@acctmind/core';
import * as shared from './icloudfile';

export function useLedgerAccess(): { access: LedgerAccess; info: SyncInfo } {
  const [, tick] = useState(0);
  useEffect(() => shared.onAccessChange(() => tick((n) => n + 1)), []);
  return { access: shared.access(), info: shared.syncInfo() };
}
