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
