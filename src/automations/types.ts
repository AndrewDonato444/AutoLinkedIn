import type { Lead } from '../api/types.js';

export type MessageGeneratorFn = (
  lead: Lead,
  icpDescription: string,
  valueProposition: string,
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

// ── ScrapingDog LinkedIn Profile Types ──────────────────────────────────────

export interface LinkedInExperience {
  position: string;
  company_name: string;
  company_url?: string;
  location: string | null;
  summary: string;
  starts_at: string;
  ends_at: string;
  duration: string;
}

export interface LinkedInEducation {
  college_name: string;
  college_url?: string;
  starts_at: string;
  ends_at: string;
}

export interface LinkedInActivity {
  link: string;
  title: string;
  activity: string;
}

export interface LinkedInProfile {
  fullName: string;
  first_name: string;
  last_name: string;
  public_identifier: string;
  headline: string;
  location: string;
  about: string;
  followers: string;
  connections: string;
  experience: LinkedInExperience[];
  education: LinkedInEducation[];
  activities: LinkedInActivity[];
  certifications: unknown[];
  recommendations: unknown[];
}

export type LinkedInScraperFn = (username: string) => Promise<LinkedInProfile | null>;
