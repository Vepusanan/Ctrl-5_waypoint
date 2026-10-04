import type { Source } from '../client';
import { dashboardSources } from './dashboard';
import { insightSources } from './insights';
import { orderSources } from './orders';
import { planningSources } from './planning';
import { replanSources } from './replan';

/**
 * Requests answered from the real API, mapped into the page contracts in ../../contracts.ts.
 * A path listed here never reaches the fixtures. Add a source when the server gains the data;
 * delete it (and its fixture) when the server serves the contract itself.
 */
export const sources: readonly Source[] = [
  ...dashboardSources,
  ...planningSources,
  ...orderSources,
  ...replanSources,
  ...insightSources,
];
