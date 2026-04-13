import type { Lead } from '../api/types.js';

export type MessageGeneratorFn = (
  lead: Lead,
  icpDescription: string,
  options: { tone: string; maxLength: number }
) => Promise<string>;

export interface MessageResult {
  lead: Lead;
  message: string;
}

export interface MessageGenerationResult {
  generated: MessageResult[];
  failed: { lead: Lead; error: string }[];
  skipped: Lead[];
  remaining: number;
}

export interface DiscoveredLead {
  firstName: string;
  lastName: string;
  profileUrl: string;
  company?: string;
  jobTitle?: string;
  location?: string;
  icpFitReason?: string;
}

export interface DiscoveryResult {
  created: DiscoveredLead[];
  skipped: DiscoveredLead[];
  failed: { lead: DiscoveredLead; error: string }[];
  limitExceeded: number;
}

export interface IntentResearch {
  fitScore: number;        // 1-100, holistic ICP + intent score
  intentSignals: string[]; // Human-readable buying signals
  reasoning: string;       // Why this score (for debugging/logging)
}

export interface EnrichmentResult {
  enriched: { lead: Lead; research: IntentResearch }[];
  failed: { lead: Lead; error: string }[];
  skipped: Lead[];
  remaining: number; // Unenriched leads still in GojiBerry
}

export type WebResearchFn = (lead: Lead, icpDescription: string) => Promise<IntentResearch>;
