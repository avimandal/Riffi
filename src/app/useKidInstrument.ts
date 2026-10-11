import { useEffect, useState } from 'react';
import type { Instrument } from '../config';
import { useApp } from './state';

/**
 * The instrument for adding or practising a piece: the current kid's main
 * instrument until someone picks another. (Kids' profiles load a moment after
 * the screen does, so this follows the profile instead of freezing the first value.)
 */
export function useKidInstrument(): [Instrument, (i: Instrument) => void] {
  const { profile } = useApp();
  const [chosen, setChosen] = useState<Instrument | null>(null);
  // A different kid: back to their own instrument.
  useEffect(() => setChosen(null), [profile?.id]);
  return [chosen ?? profile?.instrument ?? 'violin', setChosen];
}
