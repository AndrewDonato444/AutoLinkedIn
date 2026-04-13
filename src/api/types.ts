export interface Lead {
  id: string;
  firstName: string;
  lastName: string;
  profileUrl: string;
  email?: string;
  company?: string;
  jobTitle?: string;
  location?: string;
  fitScore?: number;
  intentSignals?: string[];
  personalizedMessages?: string[];
  intentType?: string;
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
  fitScore?: number;
}

export interface UpdateLeadInput {
  fitScore?: number;
  intentSignals?: string[];
  personalizedMessages?: string[];
  email?: string;
  company?: string;
  jobTitle?: string;
  location?: string;
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
