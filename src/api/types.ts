export interface PersonalizedMessage {
  content: string;
  stepNumber: number;
}

export type ContactFit = 'qualified' | 'unknown' | 'out-of-scope';
export type ContactState = 'finished' | 'paused' | '1stnetwork' | 'excluded' | 'answered';

export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  profileUrl: string;
  email?: string;
  company?: string;
  jobTitle?: string;
  location?: string;
  profileBaseline?: string;
  fit?: ContactFit;
  state?: ContactState;
  // Read-only scoring fields (computed by GojiBerry AI)
  scoring?: number;        // 0-1
  intent_scoring?: number; // 0-3
  total_scoring?: number;
  score_reasoning?: string;
  intent_keyword?: string;
  intent_type?: string;
  // Internal fields — stored in profileBaseline/note on the API, used internally for scoring logic
  fitScore?: number;
  intentSignals?: string[];
  intentType?: string;
  personalizedMessages?: PersonalizedMessage[];
  linkedin_template?: string;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateLeadInput {
  firstName: string;
  lastName: string;
  profileUrl: string;
  email?: string;
  company?: string;
  jobTitle?: string;
  location?: string;
  profileBaseline?: string;
  note?: string;
}

export interface UpdateLeadInput {
  fit?: ContactFit;
  personalizedMessages?: PersonalizedMessage[];
  profileBaseline?: string;
  email?: string;
  company?: string;
  jobTitle?: string;
  location?: string;
  // Legacy internal fields — not sent to the API, used for internal scoring logic only
  fitScore?: number;
  intentSignals?: string[];
}

export interface LeadFilters {
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  scoreFrom?: number;
  scoreTo?: number;
  intentType?: string;
  page?: number;
  pageSize?: number;
}

export interface PaginatedLeads {
  leads: Lead[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Campaign {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'completed' | 'draft';
  metrics?: {
    sent: number;
    opened: number;
    replied: number;
    converted: number;
  };
  createdAt?: string;
  updatedAt?: string;
}

export interface List {
  id: string;
  name: string;
  leadCount: number;
  createdAt?: string;
}

export interface ListWithLeads extends List {
  leads: Lead[];
}

export interface GojiBerryClientConfig {
  apiKey?: string;
  baseUrl?: string;
  rateLimit?: number;
  timeoutMs?: number;
}
