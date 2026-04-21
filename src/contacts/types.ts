import type { PersonalizedMessage, ContactFit } from '../api/types.js';

/**
 * Single event in a contact's campaign timeline — one per step (invitation,
 * message, etc.). Produced by GojiBerry; we store read-only.
 */
export interface CampaignEvent {
  type: string;                // 'invitation' | 'message' | ...
  state: string;               // 'sent' | 'accepted' | 'replied' | 'bounced' | ...
  createdAt: string;           // ISO 8601
  stepNumber: number;
}

export interface MasterContactGojiberryState {
  listId: number | null;
  /**
   * Ordered list of campaign events for this contact. Empty array if the
   * contact is not (yet) in a campaign. GojiBerry's raw `campaignStatus`
   * field is an array of these objects — we store them as-is.
   */
  campaignStatus: CampaignEvent[];
  readyForCampaign: boolean;
  bounced: boolean;
  unsubscribed: boolean;
  updatedAt: string | null;
}

export interface MasterContactSource {
  type: 'gojiberry' | 'scan-log';
  ref: string;
  fetchedAt: string;
}

export interface MasterContact {
  id: number;
  firstName: string;
  lastName: string;
  fullName: string;
  profileUrl: string;
  company: string | null;
  jobTitle: string | null;
  location: string | null;

  icpScore: number | null;
  fit: ContactFit | null;
  intentSignals: string[];
  intentType: string | null;
  reasoning: string | null;
  personalizedMessages: PersonalizedMessage[];

  email: string | null;
  phone: string | null;
  apolloPersonId: string | null;
  apolloEnrichedAt: string | null;
  apolloMatchConfidence: number | null;
  /**
   * How many Apollo errors this contact has accumulated without being
   * successfully matched. Cleared back to undefined once matched. Caps at
   * MAX_APOLLO_ERROR_RETRIES — at which point we mark the contact as
   * enriched-with-no-match so future runs stop retrying.
   */
  apolloErrorCount?: number;

  gojiberryState: MasterContactGojiberryState;

  sources: MasterContactSource[];

  masterUpdatedAt: string;

  deletedFromGojiberry?: boolean;
}

export interface ApolloMatchInput {
  linkedinUrl: string;
  firstName?: string;
  lastName?: string;
  company?: string;
}

export interface ApolloMatchResult {
  linkedinUrl: string;
  match: boolean;
  email?: string | null;
  personId?: string | null;
  confidence?: number;
}

export interface ApolloClient {
  peopleMatch(input: ApolloMatchInput): Promise<ApolloMatchResult>;
  peopleBulkMatch(inputs: ApolloMatchInput[]): Promise<ApolloMatchResult[]>;
}

export type EnrichmentOutcome = 'success' | 'no-email' | 'no-match' | 'error';

export interface EnrichmentLogEntry {
  timestamp: string;
  runId: string;
  contactId: number;
  linkedinUrl: string;
  credits: number;
  outcome: EnrichmentOutcome;
  email?: string | null;
  apolloPersonId?: string | null;
  error?: string;
  batchSize?: number;
}
